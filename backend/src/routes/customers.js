/**
 * Customer lookup routes - search across both SAP companies + get details.
 * Used by the returns dialog and future manual order entry.
 */
import { Router } from 'express';
import * as sapSql from '../services/sap/sqlReader.js';
import * as db from '../db/logisticsDb.js';
import { normalizeAddress } from '../services/addressNormalizer.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/customers/search?q=...&company=A|B|ALL
 */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { q, company = 'ALL', limit = 25 } = req.query;
    if (!q || q.length < 2) {
      return res.json({ customers: [] });
    }

    let customers;
    if (company === 'A' || company === 'B') {
      const rows = await sapSql.findCustomerByName(company, q, limit);
      customers = rows.map((r) => ({ ...r, CompanyCode: company }));
    } else {
      customers = await sapSql.searchCustomersAllCompanies(q, limit);
    }

    res.json({ customers, count: customers.length });
  })
);

/**
 * GET /api/customers/:company/:cardCode
 * Returns customer + addresses + normalized address IDs (if exist in our DB).
 */
router.get(
  '/:company/:cardCode',
  asyncHandler(async (req, res) => {
    const { company, cardCode } = req.params;

    const [customer, sapAddresses, ourLinks] = await Promise.all([
      sapSql.getCustomer(company, cardCode),
      sapSql.getCustomerAddresses(company, cardCode),
      db.query(
        `SELECT cal.SapAddressName, cal.AddressId,
                na.Street, na.BuildingNumber, na.City, na.ZipCode, na.BranchName, na.ZoneId
         FROM dbo.CustomerAddressLinks cal
         INNER JOIN dbo.NormalizedAddresses na ON na.AddressId = cal.AddressId
         INNER JOIN dbo.Companies c ON c.CompanyId = cal.CompanyId
         WHERE c.Code = @company AND cal.SapCardCode = @cardCode`,
        { company, cardCode }
      ),
    ]);

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Merge: for each SAP address, find if we have a normalized version
    const addresses = sapAddresses.map((sapAddr) => {
      const link = ourLinks.find((l) => l.SapAddressName === sapAddr.Address);
      return {
        sapAddress: sapAddr.Address,
        street: sapAddr.Street,
        buildingNumber: sapAddr.StreetNo,
        city: sapAddr.City,
        zipCode: sapAddr.ZipCode,
        normalizedAddressId: link?.AddressId || null,
        zoneId: link?.ZoneId || null,
      };
    });

    res.json({ customer: { ...customer, CompanyCode: company }, addresses });
  })
);

/**
 * GET /api/customers/:company/:cardCode/recent-items
 * Last 90 days of items bought - to prefill returns UI.
 */
router.get(
  '/:company/:cardCode/recent-items',
  asyncHandler(async (req, res) => {
    const { company, cardCode } = req.params;
    const items = await sapSql.getCustomerRecentItems(company, cardCode);
    res.json({ items });
  })
);

/**
 * POST /api/customers/:company/:cardCode/ensure-address
 * Given a raw SAP address, create or find a normalized address + link.
 * Returns the addressId to use for returns/orders.
 */
router.post(
  '/:company/:cardCode/ensure-address',
  asyncHandler(async (req, res) => {
    const { company, cardCode } = req.params;
    const { sapAddressName } = req.body;

    // 1. Look up from SAP
    const customer = await sapSql.getCustomer(company, cardCode);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const sapAddresses = await sapSql.getCustomerAddresses(company, cardCode);
    const sapAddr = sapAddressName
      ? sapAddresses.find((a) => a.Address === sapAddressName)
      : sapAddresses[0];

    if (!sapAddr) return res.status(404).json({ error: 'Address not found' });

    // 2. Normalize
    const norm = normalizeAddress({
      street: sapAddr.Street,
      buildingNumber: sapAddr.StreetNo,
      city: sapAddr.City,
      zipCode: sapAddr.ZipCode,
      branchName: sapAddr.Address,
    });

    // 3. Find or create in our DB
    let address = await db.queryOne(
      `SELECT AddressId FROM dbo.NormalizedAddresses WHERE NormalizedKey = @key`,
      { key: norm.normalizedKey }
    );

    if (!address) {
      address = await db.queryOne(
        `INSERT INTO dbo.NormalizedAddresses
           (NormalizedKey, Street, BuildingNumber, City, ZipCode, BranchName)
         OUTPUT INSERTED.AddressId
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
    }

    // 4. Link
    const companyRow = await db.queryOne(
      `SELECT CompanyId FROM dbo.Companies WHERE Code = @code`,
      { code: company }
    );

    await db.execute(
      `IF NOT EXISTS (
         SELECT 1 FROM dbo.CustomerAddressLinks
         WHERE CompanyId = @companyId AND SapCardCode = @cardCode
           AND ISNULL(SapAddressName, '') = ISNULL(@addressName, '')
       )
       INSERT INTO dbo.CustomerAddressLinks (CompanyId, SapCardCode, SapAddressName, AddressId)
       VALUES (@companyId, @cardCode, @addressName, @addressId)`,
      {
        companyId: companyRow.CompanyId,
        cardCode,
        addressName: sapAddr.Address || null,
        addressId: address.AddressId,
      }
    );

    res.json({ addressId: address.AddressId, ...address });
  })
);

export default router;
