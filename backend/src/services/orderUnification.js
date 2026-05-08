/**
 * Order Unification Service - the heart of the system.
 *
 * Problem: Two SAP companies (A, B) serve many of the same customers at the
 * same physical locations. Today each company ships separately, causing:
 *   - Duplicate pickups at the warehouse
 *   - Two trucks to the same address
 *   - No way to combine loads efficiently
 *
 * Solution: Pull open orders from both companies, normalize addresses,
 * and group orders by (normalized address). Each group becomes one delivery stop.
 *
 * Critical rule: We UNIFY logistics but KEEP accounting separate.
 * Each order stays its own SAP document - we just plan delivery together.
 */
import * as sapSql from './sap/sqlReader.js';
import * as db from '../db/logisticsDb.js';
import { normalizeAddress } from './addressNormalizer.js';
import { apiLogger } from '../utils/logger.js';

/**
 * Fetch open orders from both companies for a given date range.
 * Returns a flat list tagged with company.
 */
export async function fetchOpenOrdersBothCompanies({ fromDate, toDate } = {}) {
  apiLogger.info('Fetching open orders from both companies', { fromDate, toDate });

  const [ordersA, ordersB] = await Promise.all([
    sapSql.getOpenOrders('A', { fromDate, toDate }).then((rows) =>
      rows.map((r) => ({ ...r, CompanyCode: 'A' }))
    ),
    sapSql.getOpenOrders('B', { fromDate, toDate }).then((rows) =>
      rows.map((r) => ({ ...r, CompanyCode: 'B' }))
    ),
  ]);

  apiLogger.info(`Company A: ${ordersA.length} orders, Company B: ${ordersB.length} orders`);

  return [...ordersA, ...ordersB];
}

/**
 * Get or create a normalized address record in our DB.
 * Caches by normalizedKey to avoid duplicate lookups per call.
 */
async function findOrCreateAddress(raw, cache = new Map()) {
  const norm = normalizeAddress(raw);
  if (!norm.normalizedKey) return null;

  if (cache.has(norm.normalizedKey)) {
    return cache.get(norm.normalizedKey);
  }

  const existing = await db.queryOne(
    `SELECT AddressId, NormalizedKey, ZoneId FROM dbo.NormalizedAddresses
     WHERE NormalizedKey = @key`,
    { key: norm.normalizedKey }
  );

  if (existing) {
    cache.set(norm.normalizedKey, existing);
    return existing;
  }

  // Insert new address
  const inserted = await db.queryOne(
    `INSERT INTO dbo.NormalizedAddresses
       (NormalizedKey, Street, BuildingNumber, City, ZipCode, BranchName)
     OUTPUT INSERTED.AddressId, INSERTED.NormalizedKey, INSERTED.ZoneId
     VALUES (@key, @street, @num, @city, @zip, @branch)`,
    {
      key: norm.normalizedKey,
      street: norm.street || null,
      num: norm.buildingNumber || null,
      city: norm.city || null,
      zip: norm.zipCode || null,
      branch: norm.branchName || null,
    }
  );

  apiLogger.info('Created new NormalizedAddress', { key: norm.normalizedKey, id: inserted.AddressId });
  cache.set(norm.normalizedKey, inserted);
  return inserted;
}

/**
 * Link an SAP CardCode to a normalized address (so next time we know
 * "CardCode ABC123 in company A maps to this address").
 */
async function linkCustomerToAddress(companyCode, cardCode, addressName, addressId) {
  const companyId = await db.queryOne(
    `SELECT CompanyId FROM dbo.Companies WHERE Code = @code`,
    { code: companyCode }
  );
  if (!companyId) throw new Error(`Company ${companyCode} not found in logistics DB`);

  await db.execute(
    `IF NOT EXISTS (
        SELECT 1 FROM dbo.CustomerAddressLinks
        WHERE CompanyId = @companyId
          AND SapCardCode = @cardCode
          AND ISNULL(SapAddressName, '') = ISNULL(@addressName, '')
      )
      INSERT INTO dbo.CustomerAddressLinks (CompanyId, SapCardCode, SapAddressName, AddressId)
      VALUES (@companyId, @cardCode, @addressName, @addressId)`,
    {
      companyId: companyId.CompanyId,
      cardCode,
      addressName: addressName || null,
      addressId,
    }
  );
}

/**
 * Unify orders from both companies by destination address.
 *
 * @returns {Array<{addressId, address, orders}>}
 *   Each group has all orders from A+B going to the same normalized address.
 */
export async function unifyOrdersByAddress({ fromDate, toDate } = {}) {
  const allOrders = await fetchOpenOrdersBothCompanies({ fromDate, toDate });

  const cache = new Map();
  const groups = new Map(); // normalizedKey -> { addressId, address, orders: [] }

  for (const order of allOrders) {
    const addr = await findOrCreateAddress(
      {
        street: order.CustStreet,
        buildingNumber: order.CustBuildingNumber,
        city: order.CustCity,
        zipCode: order.CustZipCode,
        branchName: order.ShipToAddress,
      },
      cache
    );

    if (!addr) continue;

    // Link SAP customer to normalized address for future queries
    await linkCustomerToAddress(order.CompanyCode, order.CardCode, order.ShipToCode, addr.AddressId);

    if (!groups.has(addr.AddressId)) {
      groups.set(addr.AddressId, {
        addressId: addr.AddressId,
        normalizedKey: addr.NormalizedKey,
        zoneId: addr.ZoneId,
        orders: [],
      });
    }
    groups.get(addr.AddressId).orders.push({
      companyCode: order.CompanyCode,
      docEntry: order.DocEntry,
      docNum: order.DocNum,
      docDate: order.DocDate,
      docDueDate: order.DocDueDate,
      cardCode: order.CardCode,
      cardName: order.CardName,
      total: order.DocTotal,
      linesCount: order.LinesCount,
      comments: order.Comments,
    });
  }

  // Enrich with full address data for UI
  const result = [];
  for (const group of groups.values()) {
    const address = await db.queryOne(
      `SELECT AddressId, NormalizedKey, Street, BuildingNumber, City, ZipCode,
              BranchName, ZoneId, Latitude, Longitude
       FROM dbo.NormalizedAddresses WHERE AddressId = @id`,
      { id: group.addressId }
    );
    result.push({
      addressId: group.addressId,
      address,
      zoneId: group.zoneId,
      orderCount: group.orders.length,
      hasCompanyA: group.orders.some((o) => o.companyCode === 'A'),
      hasCompanyB: group.orders.some((o) => o.companyCode === 'B'),
      totalLines: group.orders.reduce((sum, o) => sum + (o.linesCount || 0), 0),
      orders: group.orders,
    });
  }

  apiLogger.info(`Unified ${allOrders.length} orders into ${result.length} delivery destinations`);
  return result;
}

/**
 * Get statistics on unification: how many "merged stops" we save per day.
 * This is the KPI the business cares about.
 */
export async function getUnificationStats({ fromDate, toDate } = {}) {
  const groups = await unifyOrdersByAddress({ fromDate, toDate });

  const totalOrders = groups.reduce((sum, g) => sum + g.orders.length, 0);
  const totalStops = groups.length;
  const mergedStops = groups.filter((g) => g.hasCompanyA && g.hasCompanyB).length;

  return {
    totalOrders,
    totalStops,
    mergedStops,
    stopsSaved: totalOrders - totalStops,
    mergeRatio: totalOrders > 0 ? (totalOrders - totalStops) / totalOrders : 0,
  };
}
