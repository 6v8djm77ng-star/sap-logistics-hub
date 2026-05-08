/**
 * SAP Field Mapping - adapt to your specific SAP B1 UDFs and extensions.
 *
 * Most queries in sqlReader.js use standard SAP table names (ORDR, OCRD, OITM).
 * BUT some sites add UDF columns (User Defined Fields) with different names.
 *
 * Edit this file to match your installation. Then restart the backend.
 *
 * Example: if your ItemMaster has a custom bin-location UDF called U_StorageBin
 *          instead of U_BinLoc, change ITEM_BIN_LOCATION_FIELD below.
 */

export const SAP_FIELDS = {
  // --- Customer (OCRD) ---
  CUSTOMER_BRANCH_FIELD: 'U_BranchName',      // Branch name UDF on customer
  CUSTOMER_ROUTE_FIELD: null,                 // Optional: preferred zone UDF

  // --- Items (OITM) ---
  ITEM_BIN_LOCATION_FIELD: 'U_BinLoc',        // Warehouse bin location UDF
  ITEM_DIMENSIONS_FIELD: null,                // Optional: dimensions for truck planning

  // --- Orders (ORDR) ---
  ORDER_SHIPTO_CODE_FIELD: 'U_ShipToCode',    // Reference to address
  ORDER_DELIVERY_WINDOW_FIELD: null,          // Optional: time window

  // --- Delivery Notes (ODLN) ---
  DN_SIGNATURE_FIELD: null,                   // Optional: signature ref

  // --- Warehouse codes ---
  DEFAULT_WAREHOUSE_CODE: '01',               // Default WhsCode for new docs
  RETURN_WAREHOUSE_CODE: '99',                // Where returns go

  // --- Company-specific overrides (if DBs differ) ---
  COMPANY_A_OVERRIDES: {},
  COMPANY_B_OVERRIDES: {},
};

/**
 * Get a field name, applying company-specific overrides.
 */
export function getField(fieldKey, companyCode = null) {
  if (companyCode === 'A' && SAP_FIELDS.COMPANY_A_OVERRIDES[fieldKey] !== undefined) {
    return SAP_FIELDS.COMPANY_A_OVERRIDES[fieldKey];
  }
  if (companyCode === 'B' && SAP_FIELDS.COMPANY_B_OVERRIDES[fieldKey] !== undefined) {
    return SAP_FIELDS.COMPANY_B_OVERRIDES[fieldKey];
  }
  return SAP_FIELDS[fieldKey];
}

/**
 * Check whether a field is configured (not null/empty).
 */
export function hasField(fieldKey, companyCode = null) {
  const v = getField(fieldKey, companyCode);
  return v != null && v !== '';
}
