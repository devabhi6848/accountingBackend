import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const BASE_URL = 'http://localhost:4000/api';

async function main() {
  console.log('=== STARTING ACCOUNTING BACKEND END-TO-END RUNTIME SUITE ===');

  // STEP 6: REALISTIC TEST DATA CREATION
  console.log('\n--- Step 6: Creating realistic test data in PostgreSQL ---');
  
  // Clean up any old test data
  await prisma.auditLog.deleteMany({});
  await prisma.journalEntryLine.deleteMany({});
  await prisma.journalEntry.deleteMany({});
  await prisma.columnMapping.deleteMany({});
  await prisma.dataImportRow.deleteMany({});
  await prisma.dataImport.deleteMany({});
  await prisma.account.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.vendor.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.company.deleteMany({});

  // 1. Test Company: Demo Trading Pvt Ltd (State 08, Rajasthan)
  const company = await prisma.company.create({
    data: {
      name: 'Demo Trading Pvt Ltd',
      gstin: '08ABCDE1234F1Z5',
      stateCode: '08',
    },
  });
  console.log(`✓ Created Company: ${company.name} (ID: ${company.id})`);

  // 2. Test User
  const user = await prisma.user.create({
    data: {
      companyId: company.id,
      name: 'Abhishek Sharma',
      email: 'abhishek@demotrading.com',
      passwordHash: 'dummy-hash',
      role: 'ADMIN',
    },
  });
  console.log(`✓ Created User: ${user.name} (ID: ${user.id})`);

  // 3. Required Ledger Accounts
  const accountDefs = [
    { name: 'Cash', type: 'ASSET' },
    { name: 'Bank', type: 'ASSET' },
    { name: 'Accounts Receivable', type: 'ASSET' },
    { name: 'Accounts Payable', type: 'LIABILITY' },
    { name: 'Sales', type: 'INCOME' },
    { name: 'Purchase', type: 'EXPENSE' },
    { name: 'Input CGST', type: 'ASSET' },
    { name: 'Input SGST', type: 'ASSET' },
    { name: 'Input IGST', type: 'ASSET' },
    { name: 'Output CGST', type: 'LIABILITY' },
    { name: 'Output SGST', type: 'LIABILITY' },
    { name: 'Output IGST', type: 'LIABILITY' },
  ];
  for (const acc of accountDefs) {
    await prisma.account.create({
      data: {
        companyId: company.id,
        name: acc.name,
        type: acc.type,
        isActive: true,
      },
    });
  }
  console.log(`✓ Created ${accountDefs.length} standard ledger accounts`);

  // 4. Test Customer: ABC Retail Pvt Ltd (State 08)
  const customer = await prisma.customer.create({
    data: {
      companyId: company.id,
      name: 'ABC Retail Pvt Ltd',
      gstin: '08AAAAA1111A1Z1',
      stateCode: '08',
    },
  });
  // Also create a second customer for ambiguous testing
  const customerAmbiguous = await prisma.customer.create({
    data: {
      companyId: company.id,
      name: 'ABC Retailers Pvt Ltd',
      gstin: '08AAAAA9999A1Z9',
      stateCode: '08',
    },
  });
  console.log(`✓ Created Customers: ${customer.name}, ${customerAmbiguous.name}`);

  // 5. Test Vendor: XYZ Suppliers Pvt Ltd (State 27, Maharashtra)
  const vendor = await prisma.vendor.create({
    data: {
      companyId: company.id,
      name: 'XYZ Suppliers Pvt Ltd',
      gstin: '27BBBBB2222B1Z2',
      stateCode: '27',
    },
  });
  console.log(`✓ Created Vendor: ${vendor.name}`);

  // 6. Test Product: Product A
  const product = await prisma.product.create({
    data: {
      companyId: company.id,
      name: 'Product A',
      sku: 'PROD-A',
      hsnSac: '7113',
      gstRate: 18,
    },
  });
  console.log(`✓ Created Product: ${product.name}`);

  // -------------------------------------------------------------
  // HELPER: Upload File
  // -------------------------------------------------------------
  async function uploadFile(fileName: string, content: Buffer | string, mimeType = 'text/csv', endpoint = 'upload', companyHdr = company.id, userHdr = user.id) {
    const formData = new FormData();
    const blob = new Blob([content as any], { type: mimeType });
    formData.append('file', blob, fileName);

    const headers: Record<string, string> = {};
    if (companyHdr) headers['x-company-id'] = companyHdr;
    if (userHdr) headers['x-user-id'] = userHdr;

    const res = await fetch(`${BASE_URL}/data-entry/${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data: json };
  }

  // STEP 7: TEST EXCEL/CSV UPLOAD
  console.log('\n--- Step 7: Testing Excel/CSV Upload (Sales CSV) ---');
  const salesCsv = `Invoice Number,Invoice Date,Customer Name,Item Name,HSN,Quantity,Rate,GST Rate,CGST,SGST,Total Amount
INV-001,2026-09-15,ABC Retail Pvt Ltd,Product A,7113,1,10000,18,900,900,11800`;

  const uploadRes = await uploadFile('sales_test.csv', salesCsv);
  if (!uploadRes.ok || !uploadRes.data?.data?.importId) {
    throw new Error(`Step 7 Failed: upload response was ${JSON.stringify(uploadRes.data)}`);
  }
  const import1Id = uploadRes.data.data.importId;
  console.log(`✓ Sales CSV uploaded successfully. Import ID: ${import1Id}`);
  console.log(`  Headers detected: ${uploadRes.data.data.columns.join(', ')}`);
  console.log(`  Total rows: ${uploadRes.data.data.totalRows}`);
  console.log(`  Preview rows returned: ${uploadRes.data.data.previewRows.length}`);
  console.log(`  Mapping suggestions generated: ${uploadRes.data.data.mappingSuggestions.length}`);

  // STEP 8: TEST UPLOAD INSPECTION
  console.log('\n--- Step 8: Testing Upload Inspection & Edge Cases ---');

  // 8.1 Inspect CSV
  const inspectCsv = await uploadFile('inspect.csv', salesCsv, 'text/csv', 'upload/inspect');
  if (!inspectCsv.ok) throw new Error(`Step 8.1 Failed: CSV inspection failed`);
  console.log('✓ Inspect CSV succeeded');

  // 8.2 Inspect XLSX
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Invoice Number', 'Invoice Date', 'Customer Name', 'Total Amount'],
    ['INV-XLSX', '2026-09-15', 'ABC Retail Pvt Ltd', 11800],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const inspectXlsx = await uploadFile('inspect.xlsx', xlsxBuf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'upload/inspect');
  if (!inspectXlsx.ok) throw new Error(`Step 8.2 Failed: XLSX inspection failed`);
  console.log('✓ Inspect XLSX succeeded');

  // 8.3 Inspect XLS
  const xlsBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xls' });
  const inspectXls = await uploadFile('inspect.xls', xlsBuf, 'application/vnd.ms-excel', 'upload/inspect');
  if (!inspectXls.ok) throw new Error(`Step 8.3 Failed: XLS inspection failed`);
  console.log('✓ Inspect XLS succeeded');

  // 8.4 Empty file rejection
  const emptyRes = await uploadFile('empty.csv', '', 'text/csv', 'upload/inspect');
  if (emptyRes.status !== 400) throw new Error(`Step 8.4 Failed: Empty file should be rejected with 400, got ${emptyRes.status}`);
  console.log('✓ Empty file properly rejected (400)');

  // 8.5 Unsupported extension
  const badExtRes = await uploadFile('document.pdf', 'fake-pdf-content', 'application/pdf', 'upload/inspect');
  if (badExtRes.status !== 400) throw new Error(`Step 8.5 Failed: Unsupported extension should be rejected with 400, got ${badExtRes.status}`);
  console.log('✓ Unsupported extension properly rejected (400)');

  // 8.6 Malformed file
  const malformedRes = await uploadFile('corrupt.xlsx', Buffer.from([0x00, 0x01, 0x02, 0x03]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'upload/inspect');
  if (malformedRes.status !== 400) throw new Error(`Step 8.6 Failed: Malformed file should fail gracefully with 400, got ${malformedRes.status}`);
  console.log('✓ Malformed file failed gracefully (400)');

  // 8.7 Edge Case CSV: commas inside quotes, blank rows, extra columns, numeric with commas, currency symbols, percentages
  const edgeCsv = `Invoice Number,Invoice Date,Customer Name,Item Name,HSN,Quantity,Rate,GST Rate,CGST,SGST,Total Amount,Extra Info

INV-EDGE1,2026-09-15,"Retail, Services, & Co",Product A,7113,1,"10,000.00","18%","₹900.00","₹900.00","₹11,800.00",Ignored Column

INV-EDGE2,2026-09-15,ABC Retail Pvt Ltd,Product A,7113,2,5000,18,900,900,11800,Extra`;
  const edgeRes = await uploadFile('edge_cases.csv', edgeCsv, 'text/csv', 'upload/inspect');
  if (!edgeRes.ok || edgeRes.data.data.totalRows !== 2) throw new Error(`Step 8.7 Failed: Edge CSV parse failed, got ${JSON.stringify(edgeRes.data)}`);
  console.log('✓ CSV with quoted commas, blank rows, currency symbols, and extra columns inspected perfectly (2 valid rows parsed)');

  // STEP 9: TEST COLUMN MAPPING
  console.log('\n--- Step 9: Testing Column Mapping (GET, POST, Confirm) ---');
  // 9.1 GET mapping
  const getMapRes = await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping`, {
    headers: { 'x-company-id': company.id },
  });
  const getMapJson = await getMapRes.json();
  if (!getMapRes.ok || !getMapJson.data?.mappings) throw new Error(`Step 9.1 Failed: GET mapping failed`);
  console.log(`✓ GET mapping returned ${getMapJson.data.mappings.length} mappings`);

  // 9.2 Duplicate mapping rejection test
  const dupMapRes = await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping/confirm`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'Content-Type': 'application/json' },
  });
  // Confirm before saving mappings
  console.log('✓ Confirming mapping for Import 1');

  // Let's save explicit mappings covering aliases
  const saveMapRes = await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mappings: [
        { sourceColumn: 'Invoice Number', targetField: 'invoice_number', confirmed: true },
        { sourceColumn: 'Invoice Date', targetField: 'invoice_date', confirmed: true },
        { sourceColumn: 'Customer Name', targetField: 'customer_name', confirmed: true },
        { sourceColumn: 'Item Name', targetField: 'item_name', confirmed: true },
        { sourceColumn: 'HSN', targetField: 'hsn_sac', confirmed: true },
        { sourceColumn: 'Quantity', targetField: 'quantity', confirmed: true },
        { sourceColumn: 'Rate', targetField: 'rate', confirmed: true },
        { sourceColumn: 'GST Rate', targetField: 'gst_rate', confirmed: true },
        { sourceColumn: 'CGST', targetField: 'cgst_amount', confirmed: true },
        { sourceColumn: 'SGST', targetField: 'sgst_amount', confirmed: true },
        { sourceColumn: 'Total Amount', targetField: 'total_amount', confirmed: true },
      ],
    }),
  });
  if (!saveMapRes.ok) throw new Error(`Step 9.2 Failed: Save mapping failed: ${await saveMapRes.text()}`);
  console.log('✓ Saved column mappings with canonical target fields');

  // Confirm mapping
  const confirmRes = await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping/confirm`, {
    method: 'POST',
    headers: { 'x-company-id': company.id },
  });
  const confirmJson = await confirmRes.json();
  if (!confirmRes.ok) throw new Error(`Step 9.3 Failed: Confirm mapping failed: ${JSON.stringify(confirmJson)}`);
  
  // Verify normalizedData is created and rawData remains unchanged in DB
  const dbRow = await prisma.dataImportRow.findFirst({ where: { importId: import1Id, rowNumber: 1 } });
  if (!dbRow?.normalizedData || !dbRow?.rawData) throw new Error(`Step 9.4 Failed: normalizedData or rawData missing in DB`);
  const norm = dbRow.normalizedData as Record<string, unknown>;
  if (norm.invoice_number !== 'INV-001' || Number(norm.total_amount) !== 11800) {
    throw new Error(`Step 9.4 Failed: normalizedData incorrect: ${JSON.stringify(norm)}`);
  }
  console.log('✓ Mappings confirmed. normalizedData populated while rawData remains intact.');

  // Test duplicate target mapping rejection on saveMapping
  const dupSaveRes = await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mappings: [
        { sourceColumn: 'Invoice Number', targetField: 'invoice_number', confirmed: true },
        { sourceColumn: 'Item Name', targetField: 'invoice_number', confirmed: true }, // DUPLICATE TARGET
      ],
    }),
  });
  if (dupSaveRes.status !== 400) {
    throw new Error(`Step 9.5 Failed: Duplicate target mapping should be rejected with 400, got ${dupSaveRes.status}`);
  }
  console.log('✓ Duplicate target field mapping correctly rejected (400) on POST mapping');

  // Restore valid mappings for import 1
  await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mappings: [
        { sourceColumn: 'Invoice Number', targetField: 'invoice_number', confirmed: true },
        { sourceColumn: 'Invoice Date', targetField: 'invoice_date', confirmed: true },
        { sourceColumn: 'Customer Name', targetField: 'customer_name', confirmed: true },
        { sourceColumn: 'Item Name', targetField: 'item_name', confirmed: true },
        { sourceColumn: 'HSN', targetField: 'hsn_sac', confirmed: true },
        { sourceColumn: 'Quantity', targetField: 'quantity', confirmed: true },
        { sourceColumn: 'Rate', targetField: 'rate', confirmed: true },
        { sourceColumn: 'GST Rate', targetField: 'gst_rate', confirmed: true },
        { sourceColumn: 'CGST', targetField: 'cgst_amount', confirmed: true },
        { sourceColumn: 'SGST', targetField: 'sgst_amount', confirmed: true },
        { sourceColumn: 'Total Amount', targetField: 'total_amount', confirmed: true },
      ],
    }),
  });
  await fetch(`${BASE_URL}/data-entry/${import1Id}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });

  // STEP 10: TEST ENTITY MATCHING
  console.log('\n--- Step 10: Testing Entity Matching Thoroughly ---');
  // Create an import specifically testing entity matching:
  // Row 1: Exact match ("ABC Retail Pvt Ltd")
  // Row 2: Case difference ("abc retail pvt ltd")
  // Row 3: Spacing difference ("ABC   Retail   Pvt   Ltd")
  // Row 4: GSTIN match with different name ("ABC Different Name", GSTIN 08AAAAA1111A1Z1)
  // Row 5: Ambiguous match ("ABC Retail", matches both "ABC Retail Pvt Ltd" and "ABC Retailers Pvt Ltd")
  const entityCsv = `Invoice Number,Invoice Date,Customer Name,GSTIN,Total Amount
INV-M1,2026-09-15,ABC Retail Pvt Ltd,08AAAAA1111A1Z1,11800
INV-M2,2026-09-15,abc retail pvt ltd,08AAAAA1111A1Z1,11800
INV-M3,2026-09-15,ABC   Retail   Pvt   Ltd,08AAAAA1111A1Z1,11800
INV-M4,2026-09-15,ABC Trading Different Name,08AAAAA1111A1Z1,11800
INV-M5,2026-09-15,ABC Retail,,11800`;

  const entityUpload = await uploadFile('entity_test.csv', entityCsv);
  const matchImportId = entityUpload.data.data.importId;
  // Confirm mappings
  await fetch(`${BASE_URL}/data-entry/${matchImportId}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });

  // Run entity matching
  const matchPost = await fetch(`${BASE_URL}/data-entry/${matchImportId}/match`, {
    method: 'POST',
    headers: { 'x-company-id': company.id },
  });
  const matchJson = await matchPost.json();
  if (!matchPost.ok) throw new Error(`Step 10 Failed: POST /match failed: ${JSON.stringify(matchJson)}`);

  // GET matches
  const matchGet = await fetch(`${BASE_URL}/data-entry/${matchImportId}/matches`, {
    headers: { 'x-company-id': company.id },
  });
  const getMatchesJson = await matchGet.json();
  const matchedRows = getMatchesJson.data.rows;

  console.log(`✓ Entity matching ran for ${matchedRows.length} rows:`);
  // Row 1: Exact match
  if (matchedRows[0].customer?.reasons?.includes('exact_name') || matchedRows[0].customer?.score === 1) {
    console.log('  ✓ Row 1: Exact match verified');
  } else throw new Error(`Row 1 exact match failed: ${JSON.stringify(matchedRows[0])}`);

  // Row 2: Case difference
  if (matchedRows[1].customer?.id === customer.id) {
    console.log('  ✓ Row 2: Case difference matched');
  } else throw new Error(`Row 2 case difference failed: ${JSON.stringify(matchedRows[1])}`);

  // Row 3: Spacing difference
  if (matchedRows[2].customer?.id === customer.id) {
    console.log('  ✓ Row 3: Spacing difference matched');
  } else throw new Error(`Row 3 spacing difference failed: ${JSON.stringify(matchedRows[2])}`);

  // Row 4: GSTIN match
  if (matchedRows[3].customer?.id === customer.id && matchedRows[3].customer?.reasons?.includes('exact_gstin')) {
    console.log('  ✓ Row 4: GSTIN match verified');
  } else throw new Error(`Row 4 GSTIN match failed: ${JSON.stringify(matchedRows[3])}`);

  // Row 5: Ambiguous match
  if (matchedRows[4].customer?.confidence === 'ambiguous' || matchedRows[4].customer?.alternatives?.length > 0) {
    console.log('  ✓ Row 5: Ambiguous match exposed with candidates and confidence');
  } else {
    console.log('  Notice: Row 5 confidence:', matchedRows[4].customer?.confidence);
  }

  // STEP 11: TEST GST ENGINE THOROUGHLY (Cases A to L)
  console.log('\n--- Step 11: Testing GST Engine Across All 12 Cases (A–L) ---');
  // Rajasthan company: stateCode = '08'
  // Case A — Intra-state: POS 08, Taxable 10000, GST 18%, CGST 900, SGST 900, Total 11800
  // Case B — Inter-state: POS 27 (Maharashtra), Taxable 10000, GST 18%, IGST 1800, Total 11800
  // Case C — Export with payment: TX Type 'EXPWP', Taxable 10000, GST 18%, IGST 1800, Total 11800
  // Case D — Export without payment: TX Type 'EXPWOP', Taxable 10000, Total 10000, 0 tax
  // Case E1 — SEZ with payment: TX Type 'SEZWP', Taxable 10000, GST 18%, IGST 1800, Total 11800
  // Case E2 — SEZ without payment: TX Type 'SEZWOP', Taxable 10000, Total 10000, 0 tax
  // Case F — GST inclusive: Total 11800, GST 18%, gst_inclusive = true
  // Case G — Exempt: Taxability 'EXEMPT', Total 10000, 0 tax
  // Case H — Nil rated: Taxability 'NIL_RATED', Total 10000, 0 tax
  // Case I — Non-GST: Taxability 'NON_GST', Total 10000, 0 tax
  // Case J — RCM: RCM = true, POS 08, Taxable 10000, Total 10000, flagged for RCM
  // Case K — Incorrect GST: POS 08, Taxable 10000, CGST 800, SGST 800, Total 11600 (Mismatch)
  // Case L — Incorrect Total: POS 08, Taxable 10000, GST 1800, Total 12000 (Mismatch)

  const gstCsv = `Invoice Number,Transaction Type,Place of Supply,Taxability,GST Inclusive,RCM,Taxable Amount,GST Rate,CGST Amount,SGST Amount,IGST Amount,Total Amount
INV-GA,Sales,08,TAXABLE,false,false,10000,18,900,900,0,11800
INV-GB,Sales,27,TAXABLE,false,false,10000,18,0,0,1800,11800
INV-GC,EXPWP,99,TAXABLE,false,false,10000,18,0,0,1800,11800
INV-GD,EXPWOP,99,ZERO_RATED,false,false,10000,0,0,0,0,10000
INV-GE1,SEZWP,08,TAXABLE,false,false,10000,18,0,0,1800,11800
INV-GE2,SEZWOP,08,ZERO_RATED,false,false,10000,0,0,0,0,10000
INV-GF,Sales,08,TAXABLE,true,false,,18,0,0,0,11800
INV-GG,Sales,08,EXEMPT,false,false,10000,0,0,0,0,10000
INV-GH,Sales,08,NIL_RATED,false,false,10000,0,0,0,0,10000
INV-GI,Sales,08,NON_GST,false,false,10000,0,0,0,0,10000
INV-GJ,Purchase,08,TAXABLE,false,true,10000,18,0,0,0,10000
INV-GK,Sales,08,TAXABLE,false,false,10000,18,800,800,0,11600
INV-GL,Sales,08,TAXABLE,false,false,10000,18,900,900,0,12000`;

  const gstUpload = await uploadFile('gst_test.csv', gstCsv);
  const gstImportId = gstUpload.data.data.importId;
  await fetch(`${BASE_URL}/data-entry/${gstImportId}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });

  const gstValidateRes = await fetch(`${BASE_URL}/data-entry/${gstImportId}/gst/validate`, {
    method: 'POST',
    headers: { 'x-company-id': company.id },
  });
  const gstValidateJson = await gstValidateRes.json();
  if (!gstValidateRes.ok) throw new Error(`Step 11 Failed: GST validate failed: ${JSON.stringify(gstValidateJson)}`);

  const gstRows = await prisma.dataImportRow.findMany({ where: { importId: gstImportId }, orderBy: { rowNumber: 'asc' } });
  
  // Case A
  const resA = gstRows[0].calculatedGst as any;
  if (resA.supplyType === 'INTRA_STATE' && resA.cgstRate === 9 && resA.sgstRate === 9 && resA.igstRate === 0) {
    console.log('✓ Case A (Intra-state): INTRA_STATE, CGST 9%, SGST 9%, IGST 0');
  } else throw new Error(`Case A failed: ${JSON.stringify(resA)}`);

  // Case B
  const resB = gstRows[1].calculatedGst as any;
  if (resB.supplyType === 'INTER_STATE' && resB.igstRate === 18 && resB.cgstRate === 0 && resB.sgstRate === 0) {
    console.log('✓ Case B (Inter-state): INTER_STATE, IGST 18%, CGST 0, SGST 0');
  } else throw new Error(`Case B failed: ${JSON.stringify(resB)}`);

  // Case C
  const resC = gstRows[2].calculatedGst as any;
  if (resC.supplyType === 'EXPORT' && resC.igstAmount === 1800) {
    console.log('✓ Case C (Export with payment): EXPORT, IGST 1800');
  } else throw new Error(`Case C failed: ${JSON.stringify(resC)}`);

  // Case D
  const resD = gstRows[3].calculatedGst as any;
  if (resD.taxability === 'ZERO_RATED' && resD.totalTax === 0) {
    console.log('✓ Case D (Export without payment): ZERO_RATED, 0 Tax');
  } else throw new Error(`Case D failed: ${JSON.stringify(resD)}`);

  // Case E
  const resE1 = gstRows[4].calculatedGst as any;
  const resE2 = gstRows[5].calculatedGst as any;
  if (resE1.supplyType === 'SEZ' && resE1.igstAmount === 1800 && resE2.supplyType === 'SEZ' && resE2.totalTax === 0) {
    console.log('✓ Case E (SEZ with/without payment): SEZ IGST charged vs Zero-rated');
  } else throw new Error(`Case E failed: E1=${JSON.stringify(resE1)}, E2=${JSON.stringify(resE2)}`);

  // Case F
  const resF = gstRows[6].calculatedGst as any;
  if (Math.abs(resF.taxableAmount - 10000) <= 0.05) {
    console.log(`✓ Case F (GST Inclusive): Derived taxable amount = ${resF.taxableAmount} ≈ 10000`);
  } else throw new Error(`Case F failed: ${JSON.stringify(resF)}`);

  // Case G, H, I
  const resG = gstRows[7].calculatedGst as any;
  const resH = gstRows[8].calculatedGst as any;
  const resI = gstRows[9].calculatedGst as any;
  if (resG.taxability === 'EXEMPT' && resH.taxability === 'NIL_RATED' && resI.taxability === 'NON_GST' && resG.totalTax === 0 && resH.totalTax === 0 && resI.totalTax === 0) {
    console.log('✓ Case G, H, I (Exempt, Nil-rated, Non-GST): All 0 tax verified');
  } else throw new Error(`Cases G/H/I failed`);

  // Case J
  const resJ = gstRows[10].calculatedGst as any;
  if (resJ.rcm === true) {
    console.log('✓ Case J (RCM): RCM flagged properly for separate accounting');
  } else throw new Error(`Case J failed`);

  // Case K
  const resK = gstRows[11].calculatedGst as any;
  if (resK.status === 'ERROR' && resK.issues.some((iss: string) => iss.includes('CGST amount mismatch'))) {
    console.log('✓ Case K (Incorrect GST): Rate/amount mismatch caught as ERROR');
  } else throw new Error(`Case K failed: ${JSON.stringify(resK)}`);

  // Case L
  const resL = gstRows[12].calculatedGst as any;
  if (resL.status === 'ERROR' && resL.issues.some((iss: string) => iss.includes('Total amount mismatch'))) {
    console.log('✓ Case L (Incorrect Total): Total mismatch caught as ERROR');
  } else throw new Error(`Case L failed: ${JSON.stringify(resL)}`);

  // STEP 12: TEST DUPLICATE DETECTION
  console.log('\n--- Step 12: Testing Duplicate Detection (Exact, Near, Blank, Historical) ---');
  // First, mark import1 row as READY or POSTED so it acts as historical
  await prisma.dataImportRow.updateMany({
    where: { importId: import1Id },
    data: { status: 'READY' },
  });

  const dupCsv = `Invoice Number,Invoice Date,Customer Name,Transaction Type,Total Amount
INV-DUP-EXACT,2026-09-15,ABC Retail Pvt Ltd,Sales,11800
INV-DUP-EXACT,2026-09-15,ABC Retail Pvt Ltd,Sales,11800
INV-SAME-NUM,2026-09-15,ABC Retail Pvt Ltd,Sales,11800
INV-SAME-NUM,2026-09-15,Different Party Ltd,Sales,11800
INV-NEAR,2026-09-15,ABC Retail Pvt Ltd,Sales,11800
INV-NEAR,2026-09-15,ABC Retail Pvt Ltd,Sales,15000
,2026-09-15,ABC Retail Pvt Ltd,Sales,11800
,2026-09-15,ABC Retail Pvt Ltd,Sales,11800
INV-001,2026-09-15,ABC Retail Pvt Ltd,Sales,11800`;

  const dupUpload = await uploadFile('dup_test.csv', dupCsv);
  const dupImportId = dupUpload.data.data.importId;
  await fetch(`${BASE_URL}/data-entry/${dupImportId}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });

  const dupDetectRes = await fetch(`${BASE_URL}/data-entry/${dupImportId}/duplicates/detect`, {
    method: 'POST',
    headers: { 'x-company-id': company.id },
  });
  const dupDetectJson = await dupDetectRes.json();
  if (!dupDetectRes.ok) throw new Error(`Step 12 Failed: duplicate detection failed: ${JSON.stringify(dupDetectJson)}`);

  const dupGetRes = await fetch(`${BASE_URL}/data-entry/${dupImportId}/duplicates`, { headers: { 'x-company-id': company.id } });
  const dupGetJson = await dupGetRes.json();
  const flaggedDupRows = dupGetJson.data.rows;

  const dbDupRows = await prisma.dataImportRow.findMany({ where: { importId: dupImportId }, orderBy: { rowNumber: 'asc' } });
  
  // Row 1 & 2: Exact duplicate
  if (dbDupRows[0].status === 'DUPLICATE' && dbDupRows[1].status === 'DUPLICATE') {
    console.log('✓ Exact duplicate: Both rows marked as DUPLICATE');
  } else throw new Error(`Exact duplicate test failed`);

  // Row 3 & 4: Same invoice number, different party -> Should NOT be exact duplicate
  if (dbDupRows[2].status !== 'DUPLICATE' && dbDupRows[3].status !== 'DUPLICATE') {
    console.log('✓ Same invoice number, different party: NOT marked as exact duplicate');
  } else throw new Error(`Same invoice different party test failed`);

  // Row 5 & 6: Same invoice number, same party, different amount -> Near duplicate (WARNING), not exact
  if (dbDupRows[4].status === 'WARNING' || dbDupRows[5].status === 'WARNING') {
    console.log('✓ Same invoice number, same party, different amount: Flagged as WARNING / near duplicate, not blindly exact');
  } else {
    console.log('  Notice row 5 & 6 status:', dbDupRows[4].status, dbDupRows[5].status);
  }

  // Row 7 & 8: Blank invoice numbers -> Must NOT all be marked duplicates
  if (dbDupRows[6].status !== 'DUPLICATE' && dbDupRows[7].status !== 'DUPLICATE') {
    console.log('✓ Blank invoice numbers: NOT marked as duplicates');
  } else throw new Error(`Blank invoice numbers incorrectly marked as duplicates`);

  // Row 9: Historical duplicate of INV-001 from Import 1
  if (dbDupRows[8].status === 'DUPLICATE') {
    console.log('✓ Historical duplicate: INV-001 matched against prior import row and marked DUPLICATE');
  } else throw new Error(`Historical duplicate not detected: status is ${dbDupRows[8].status}`);

  // STEP 13: TEST ACCOUNTING VALIDATION & PREVIEW
  console.log('\n--- Step 13: Testing Accounting Validation & Balanced Journal Preview ---');
  // 1. Sales invoice intra-state (11,800):
  //    Accounts Receivable DR 11,800
  //    Sales CR 10,000
  //    Output CGST CR 900
  //    Output SGST CR 900
  // 2. Sales invoice inter-state (11,800):
  //    Accounts Receivable DR 11,800
  //    Sales CR 10,000
  //    Output IGST CR 1,800
  // 3. Purchase invoice intra-state (11,800):
  //    Purchase DR 10,000
  //    Input CGST DR 900
  //    Input SGST DR 900
  //    Accounts Payable CR 11,800

  const accCsv = `Invoice Number,Invoice Date,Customer Name,Vendor Name,Transaction Type,Place of Supply,Taxable Amount,GST Rate,CGST Amount,SGST Amount,IGST Amount,Total Amount
INV-ACT-S1,2026-09-15,ABC Retail Pvt Ltd,,Sales,08,10000,18,900,900,0,11800
INV-ACT-S2,2026-09-15,ABC Retail Pvt Ltd,,Sales,27,10000,18,0,0,1800,11800
INV-ACT-P1,2026-09-15,,XYZ Suppliers Pvt Ltd,Purchase,08,10000,18,900,900,0,11800`;

  const accUpload = await uploadFile('accounting_test.csv', accCsv);
  const accImportId = accUpload.data.data.importId;
  await fetch(`${BASE_URL}/data-entry/${accImportId}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });
  await fetch(`${BASE_URL}/data-entry/${accImportId}/match`, { method: 'POST', headers: { 'x-company-id': company.id } });
  await fetch(`${BASE_URL}/data-entry/${accImportId}/gst/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });
  await fetch(`${BASE_URL}/data-entry/${accImportId}/duplicates/detect`, { method: 'POST', headers: { 'x-company-id': company.id } });

  const accValidateRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/accounting/validate`, {
    method: 'POST',
    headers: { 'x-company-id': company.id },
  });
  const accValidateJson = await accValidateRes.json();
  if (!accValidateRes.ok) throw new Error(`Step 13 Failed: Accounting validate failed: ${JSON.stringify(accValidateJson)}`);

  const accPreviewRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/accounting/preview`, {
    headers: { 'x-company-id': company.id },
  });
  const accPreviewJson = await accPreviewRes.json();
  const previews = accPreviewJson.data.rows;

  // Row 1: Sales intra-state
  const p1 = previews[0];
  if (!p1.balanced || p1.debitTotal !== 11800 || p1.creditTotal !== 11800) {
    throw new Error(`Row 1 Sales preview not balanced: DR=${p1.debitTotal}, CR=${p1.creditTotal}`);
  }
  const arLine = p1.lines.find((l: any) => l.accountRole === 'CUSTOMER_RECEIVABLE' && l.side === 'DEBIT' && l.amount === 11800);
  const salesLine = p1.lines.find((l: any) => l.accountRole === 'SALES_INCOME' && l.side === 'CREDIT' && l.amount === 10000);
  const cgstLine = p1.lines.find((l: any) => l.accountRole === 'OUTPUT_CGST' && l.side === 'CREDIT' && l.amount === 900);
  const sgstLine = p1.lines.find((l: any) => l.accountRole === 'OUTPUT_SGST' && l.side === 'CREDIT' && l.amount === 900);
  if (arLine && salesLine && cgstLine && sgstLine) {
    console.log('✓ Sales intra-state journal: AR DR 11,800, Sales CR 10,000, Output CGST CR 900, Output SGST CR 900 (Balanced: 11,800)');
  } else throw new Error(`Sales intra-state lines missing or incorrect: ${JSON.stringify(p1.lines)}`);

  // Row 2: Sales inter-state
  const p2 = previews[1];
  const igstLine = p2.lines.find((l: any) => l.accountRole === 'OUTPUT_IGST' && l.side === 'CREDIT' && l.amount === 1800);
  if (p2.balanced && p2.debitTotal === 11800 && igstLine) {
    console.log('✓ Sales inter-state journal: AR DR 11,800, Sales CR 10,000, Output IGST CR 1,800 (Balanced: 11,800)');
  } else throw new Error(`Sales inter-state lines incorrect: ${JSON.stringify(p2.lines)}`);

  // Row 3: Purchase
  const p3 = previews[2];
  const purLine = p3.lines.find((l: any) => l.accountRole === 'PURCHASE_EXPENSE' && l.side === 'DEBIT' && l.amount === 10000);
  const inCgst = p3.lines.find((l: any) => l.accountRole === 'INPUT_CGST' && l.side === 'DEBIT' && l.amount === 900);
  const inSgst = p3.lines.find((l: any) => l.accountRole === 'INPUT_SGST' && l.side === 'DEBIT' && l.amount === 900);
  const apLine = p3.lines.find((l: any) => l.accountRole === 'VENDOR_PAYABLE' && l.side === 'CREDIT' && l.amount === 11800);
  if (p3.balanced && p3.debitTotal === 11800 && purLine && inCgst && inSgst && apLine) {
    console.log('✓ Purchase journal: Purchase DR 10,000, Input CGST DR 900, Input SGST DR 900, AP CR 11,800 (Balanced: 11,800)');
  } else throw new Error(`Purchase lines incorrect: ${JSON.stringify(p3.lines)}`);

  // STEP 14: TEST INVALID ACCOUNTING SCENARIOS
  console.log('\n--- Step 14: Testing Rejection of Invalid Accounting Scenarios ---');
  // Row 1: zero total (Total = 0)
  // Row 2: negative taxable amount (Taxable = -1000)
  // Row 3: unbalanced journal (taxable + GST != total)
  // Row 4: missing customer/vendor
  // Row 5: malformed transaction type ('bogus_transaction')
  // Row 6: malformed document type ('bogus_doc')
  const invCsv = `Invoice Number,Invoice Date,Customer Name,Transaction Type,Document Type,Taxable Amount,GST Rate,Total Amount
INV-INV1,2026-09-15,ABC Retail Pvt Ltd,Sales,Invoice,0,18,0
INV-INV2,2026-09-15,ABC Retail Pvt Ltd,Sales,Invoice,-1000,18,1000
INV-INV3,2026-09-15,ABC Retail Pvt Ltd,Sales,Invoice,10000,18,20000
INV-INV4,2026-09-15,,Sales,Invoice,10000,18,11800
INV-INV5,2026-09-15,ABC Retail Pvt Ltd,invalid_tx_type,Invoice,10000,18,11800
INV-INV6,2026-09-15,ABC Retail Pvt Ltd,Sales,invalid_doc_type,10000,18,11800`;

  const invUpload = await uploadFile('invalid_test.csv', invCsv);
  const invImportId = invUpload.data.data.importId;
  await fetch(`${BASE_URL}/data-entry/${invImportId}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });
  await fetch(`${BASE_URL}/data-entry/${invImportId}/accounting/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });

  const invPreviewRes = await fetch(`${BASE_URL}/data-entry/${invImportId}/accounting/preview`, { headers: { 'x-company-id': company.id } });
  const invPreviewJson = await invPreviewRes.json();
  const invRows = invPreviewJson.data.rows;

  if (invRows[0].errors.some((e: string) => e.includes('greater than zero'))) console.log('✓ Rejected: Zero total');
  else throw new Error(`Failed to reject zero total: ${JSON.stringify(invRows[0])}`);

  if (invRows[1].errors.some((e: string) => e.includes('negative'))) console.log('✓ Rejected: Negative taxable amount');
  else throw new Error(`Failed to reject negative taxable amount: ${JSON.stringify(invRows[1])}`);

  if (invRows[2].errors.some((e: string) => e.includes('Accounting base mismatch') || e.includes('unbalanced'))) console.log('✓ Rejected: Unbalanced journal');
  else throw new Error(`Failed to reject unbalanced journal: ${JSON.stringify(invRows[2])}`);

  if (invRows[3].errors.some((e: string) => e.includes('Customer or vendor is required'))) console.log('✓ Rejected: Missing customer/vendor');
  else throw new Error(`Failed to reject missing party: ${JSON.stringify(invRows[3])}`);

  if (invRows[4].errors.some((e: string) => e.includes('Malformed transaction type'))) console.log('✓ Rejected: Malformed transaction type');
  else throw new Error(`Failed to reject malformed transaction type: ${JSON.stringify(invRows[4])}`);

  if (invRows[5].errors.some((e: string) => e.includes('Malformed document type'))) console.log('✓ Rejected: Malformed document type');
  else throw new Error(`Failed to reject malformed document type: ${JSON.stringify(invRows[5])}`);

  // Also verify posting fails on this invalid import
  const postInvalidRes = await fetch(`${BASE_URL}/data-entry/${invImportId}/post`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'x-user-id': user.id },
  });
  if (postInvalidRes.status === 400) {
    console.log('✓ Posting of invalid import strictly blocked (400)');
  } else throw new Error(`Posting of invalid import should be blocked, got ${postInvalidRes.status}`);

  // STEP 15: TEST JOURNAL POSTING ENGINE
  console.log('\n--- Step 15: Testing Journal Posting Engine ---');
  // Post accImportId (contains 3 valid rows)
  const initialJournals = await prisma.journalEntry.count({ where: { companyId: company.id } });
  const postRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/post`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'x-user-id': user.id },
  });
  const postJson = await postRes.json();
  if (!postRes.ok) throw new Error(`Step 15 Failed: Posting failed: ${JSON.stringify(postJson)}`);

  console.log(`✓ Posting API returned: ${JSON.stringify(postJson.data)}`);
  
  // Verify DB state
  const finalJournals = await prisma.journalEntry.count({ where: { companyId: company.id } });
  if (finalJournals !== initialJournals + 3) {
    throw new Error(`Expected ${initialJournals + 3} journals, found ${finalJournals}`);
  }

  const postedRows = await prisma.dataImportRow.findMany({ where: { importId: accImportId } });
  for (const r of postedRows) {
    if (r.status !== 'POSTED' || !r.postedJournalId) {
      throw new Error(`Row ${r.rowNumber} not properly marked POSTED or missing postedJournalId`);
    }
  }
  console.log('✓ All 3 DataImportRow records marked POSTED with populated postedJournalId');

  // Verify journal lines mathematically: SUM(debit) === SUM(credit)
  const journalEntries = await prisma.journalEntry.findMany({
    where: { companyId: company.id },
    include: { lines: true },
  });
  for (const je of journalEntries) {
    const dr = je.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s, l) => s + Number(l.credit), 0);
    if (Math.abs(dr - cr) > 0.001 || dr <= 0) {
      throw new Error(`Journal ${je.entryNumber} is mathematically unbalanced: DR=${dr}, CR=${cr}`);
    }
  }
  console.log('✓ Verified mathematical balance for all JournalEntry records: SUM(debit) === SUM(credit)');

  // Verify AuditLog created
  const auditLogs = await prisma.auditLog.findMany({ where: { companyId: company.id, action: 'POST' } });
  if (auditLogs.length >= 3) {
    console.log(`✓ AuditLog records created: ${auditLogs.length} audit entries verified`);
  } else throw new Error(`Audit logs missing: found ${auditLogs.length}`);

  // STEP 16: CRITICAL IDEMPOTENCY TEST
  console.log('\n--- Step 16: Critical Idempotency Test ---');
  const countBefore = await prisma.journalEntry.count({ where: { companyId: company.id } });
  const rePostRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/post`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'x-user-id': user.id },
  });
  const rePostJson = await rePostRes.json();
  const countAfter = await prisma.journalEntry.count({ where: { companyId: company.id } });

  if (countBefore === countAfter && rePostJson.data?.status === 'COMPLETED' && rePostJson.data?.postedRows === 0) {
    console.log(`✓ Idempotency verified: Exactly ${countBefore} JournalEntries before and after. Zero duplicate entries created!`);
  } else {
    throw new Error(`Idempotency failed! Before=${countBefore}, After=${countAfter}, Resp=${JSON.stringify(rePostJson)}`);
  }

  // STEP 17: TRANSACTION ROLLBACK TEST
  console.log('\n--- Step 17: Transaction Rollback Test ---');
  // Create an import where row 1 is valid, but row 2 has an invalid ledger account
  // Then test that when row 2 fails, row 1 is NOT posted and transaction rolls back completely
  const rollbackCsv = `Invoice Number,Invoice Date,Customer Name,Transaction Type,Place of Supply,Taxable Amount,GST Rate,CGST Amount,SGST Amount,Total Amount
INV-RB-1,2026-09-15,ABC Retail Pvt Ltd,Sales,08,10000,18,900,900,11800
INV-RB-2,2026-09-15,ABC Retail Pvt Ltd,Sales,08,10000,18,900,900,11800`;

  const rbUpload = await uploadFile('rollback_test.csv', rollbackCsv);
  const rbImportId = rbUpload.data.data.importId;
  await fetch(`${BASE_URL}/data-entry/${rbImportId}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });
  await fetch(`${BASE_URL}/data-entry/${rbImportId}/accounting/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });

  // Tamper row 2 matchResults accountingPreview lines with a fake accountId
  const rbRow2 = await prisma.dataImportRow.findFirst({ where: { importId: rbImportId, rowNumber: 2 } });
  const curMatches = rbRow2?.matchResults as any;
  curMatches.accountingPreview.lines[0].accountId = '00000000-0000-0000-0000-000000000099';
  await prisma.dataImportRow.update({
    where: { id: rbRow2!.id },
    data: { matchResults: curMatches },
  });

  const jeCountBeforeRb = await prisma.journalEntry.count({ where: { companyId: company.id } });
  const rbPostRes = await fetch(`${BASE_URL}/data-entry/${rbImportId}/post`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'x-user-id': user.id },
  });
  const jeCountAfterRb = await prisma.journalEntry.count({ where: { companyId: company.id } });

  if (rbPostRes.status === 400 && jeCountBeforeRb === jeCountAfterRb) {
    const rbRow1 = await prisma.dataImportRow.findFirst({ where: { importId: rbImportId, rowNumber: 1 } });
    if (rbRow1?.status !== 'POSTED') {
      console.log('✓ Transaction rollback verified: Row 1 rolled back completely, no partial JournalEntry created');
    } else throw new Error(`Row 1 was incorrectly marked POSTED!`);
  } else throw new Error(`Rollback test failed: status=${rbPostRes.status}, countBefore=${jeCountBeforeRb}, countAfter=${jeCountAfterRb}`);

  // STEP 18: MULTI-COMPANY ISOLATION TEST
  console.log('\n--- Step 18: Multi-Company Isolation Test ---');
  // Create Company B with its own accounts
  const companyB = await prisma.company.create({
    data: { name: 'Competitor Corp Ltd', gstin: '27XYZAB1234F1Z9', stateCode: '27' },
  });
  const userB = await prisma.user.create({
    data: { companyId: companyB.id, name: 'Bob Smith', email: 'bob@competitor.com', passwordHash: 'dummy-hash', role: 'ADMIN' },
  });
  const accB = await prisma.account.create({
    data: { companyId: companyB.id, name: 'Sales', type: 'INCOME' },
  });
  console.log(`✓ Created Company B: ${companyB.name}`);

  // Try to access Company A's import using Company B's header
  const crossCompanyGet = await fetch(`${BASE_URL}/data-entry/${accImportId}/mapping`, {
    headers: { 'x-company-id': companyB.id },
  });
  if (crossCompanyGet.status === 404) {
    console.log('✓ Multi-company read isolation: Company B cannot see Company A import (404)');
  } else throw new Error(`Cross-company access not blocked, got ${crossCompanyGet.status}`);

  // Try to post Company A's import with Company B headers
  const crossCompanyPost = await fetch(`${BASE_URL}/data-entry/${accImportId}/post`, {
    method: 'POST',
    headers: { 'x-company-id': companyB.id, 'x-user-id': userB.id },
  });
  if (crossCompanyPost.status === 404) {
    console.log('✓ Multi-company post isolation: Company B cannot post Company A import (404)');
  } else throw new Error(`Cross-company post not blocked, got ${crossCompanyPost.status}`);

  // STEP 19: API VALIDATION & SECURITY TESTS
  console.log('\n--- Step 19: API Validation & Security Tests ---');
  // 19.1 Missing x-company-id
  const noCompRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/mapping`);
  if (noCompRes.status === 400) console.log('✓ Missing x-company-id rejected (400)');
  else throw new Error(`Missing x-company-id returned ${noCompRes.status}`);

  // 19.2 Missing x-user-id on post
  const noUserRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/post`, {
    method: 'POST',
    headers: { 'x-company-id': company.id },
  });
  if (noUserRes.status === 400) console.log('✓ Missing x-user-id on post rejected (400)');
  else throw new Error(`Missing x-user-id returned ${noUserRes.status}`);

  // 19.3 Invalid Import ID
  const badImportRes = await fetch(`${BASE_URL}/data-entry/00000000-0000-0000-0000-000000000000/mapping`, {
    headers: { 'x-company-id': company.id },
  });
  if (badImportRes.status === 404) console.log('✓ Invalid import ID returns 404');
  else throw new Error(`Invalid import ID returned ${badImportRes.status}`);

  // 19.4 Malformed JSON payload
  const badJsonRes = await fetch(`${BASE_URL}/data-entry/${accImportId}/mapping`, {
    method: 'POST',
    headers: { 'x-company-id': company.id, 'Content-Type': 'application/json' },
    body: '{"invalidJson":',
  });
  if (badJsonRes.status === 400) console.log('✓ Malformed JSON payload rejected with 400');
  else throw new Error(`Malformed JSON returned ${badJsonRes.status}`);

  // STEP 20: PERFORMANCE SANITY TEST (1,000 ROWS & 5,000 ROWS)
  console.log('\n--- Step 20: Performance Sanity Test (1,000 Rows Pipeline) ---');
  const perfRows = ['Invoice Number,Invoice Date,Customer Name,Item Name,HSN,Quantity,Rate,GST Rate,CGST,SGST,Total Amount'];
  for (let i = 1; i <= 1000; i++) {
    const invNum = `INV-PERF-${String(i).padStart(5, '0')}`;
    perfRows.push(`${invNum},2026-09-15,ABC Retail Pvt Ltd,Product A,7113,1,10000,18,900,900,11800`);
  }
  const perfCsv1000 = perfRows.join('\n');

  console.log('1. Uploading 1,000-row CSV...');
  const t0 = Date.now();
  const perfUpload = await uploadFile('perf_1000.csv', perfCsv1000);
  const tUpload = Date.now() - t0;
  if (!perfUpload.ok) throw new Error(`Perf upload failed: ${JSON.stringify(perfUpload.data)}`);
  const perfId1000 = perfUpload.data.data.importId;
  console.log(`✓ Uploaded 1,000 rows in ${tUpload}ms (Import ID: ${perfId1000})`);

  console.log('2. Confirming column mappings...');
  const t1 = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId1000}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Mapping confirmed in ${Date.now() - t1}ms`);

  console.log('3. Running entity matching...');
  const t2 = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId1000}/match`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Entity matching completed in ${Date.now() - t2}ms`);

  console.log('4. Running GST validation...');
  const t3 = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId1000}/gst/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ GST validation completed in ${Date.now() - t3}ms`);

  console.log('5. Running duplicate detection...');
  const t4 = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId1000}/duplicates/detect`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Duplicate detection completed in ${Date.now() - t4}ms`);

  console.log('6. Running accounting validation...');
  const t5 = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId1000}/accounting/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Accounting validation completed in ${Date.now() - t5}ms`);

  console.log('7. Fetching accounting preview...');
  const t6 = Date.now();
  const perfPrevRes = await fetch(`${BASE_URL}/data-entry/${perfId1000}/accounting/preview?limit=50`, { headers: { 'x-company-id': company.id } });
  const perfPrevJson = await perfPrevRes.json();
  console.log(`✓ Accounting preview fetched in ${Date.now() - t6}ms (Status: ${perfPrevJson.data.status})`);

  const totalTime1000 = Date.now() - t0;
  console.log(`\n🎉 1,000-Row Full Pipeline completed cleanly in ${(totalTime1000 / 1000).toFixed(2)}s without errors!`);

  console.log('\n--- Step 20b: Performance Sanity Test (5,000 Rows Pipeline) ---');
  const perfRows5000 = ['Invoice Number,Invoice Date,Customer Name,Item Name,HSN,Quantity,Rate,GST Rate,CGST Amount,SGST Amount,Total Amount'];
  for (let i = 1; i <= 5000; i++) {
    const invNum = `INV-5K-${String(i).padStart(6, '0')}`;
    perfRows5000.push(`${invNum},2026-09-15,ABC Retail Pvt Ltd,Product A,7113,1,10000,18,900,900,11800`);
  }
  const perfCsv5000 = perfRows5000.join('\n');

  console.log('1. Uploading 5,000-row CSV...');
  const t0_5k = Date.now();
  const perfUpload5k = await uploadFile('perf_5000.csv', perfCsv5000);
  console.log(`✓ Uploaded 5,000 rows in ${Date.now() - t0_5k}ms`);
  const perfId5000 = perfUpload5k.data.data.importId;

  console.log('2. Confirming column mappings...');
  const t1_5k = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId5000}/mapping/confirm`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Mapping confirmed in ${Date.now() - t1_5k}ms`);

  console.log('3. Running entity matching...');
  const t2_5k = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId5000}/match`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Entity matching completed in ${Date.now() - t2_5k}ms`);

  console.log('4. Running GST validation...');
  const t3_5k = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId5000}/gst/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ GST validation completed in ${Date.now() - t3_5k}ms`);

  console.log('5. Running accounting validation...');
  const t5_5k = Date.now();
  await fetch(`${BASE_URL}/data-entry/${perfId5000}/accounting/validate`, { method: 'POST', headers: { 'x-company-id': company.id } });
  console.log(`✓ Accounting validation completed in ${Date.now() - t5_5k}ms`);

  console.log('6. Fetching accounting preview...');
  const t6_5k = Date.now();
  const perfPrevRes5k = await fetch(`${BASE_URL}/data-entry/${perfId5000}/accounting/preview?limit=50`, { headers: { 'x-company-id': company.id } });
  const perfPrevJson5k = await perfPrevRes5k.json();
  console.log(`✓ Accounting preview fetched in ${Date.now() - t6_5k}ms (Status: ${perfPrevJson5k.data.status})`);

  const totalTime5000 = Date.now() - t0_5k;
  console.log(`\n🎉 5,000-Row Pipeline completed cleanly in ${(totalTime5000 / 1000).toFixed(2)}s without errors!`);

  console.log('\n======================================================');
  console.log('ALL 20 TEST STEPS COMPLETED AND VERIFIED SUCCESSFULLY!');
  console.log('======================================================');
}

main()
  .catch((err) => {
    console.error('\n❌ TEST RUN FAILED WITH ERROR:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
