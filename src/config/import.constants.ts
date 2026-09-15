export const CANONICAL_IMPORT_FIELDS = [
  'customer_name',
  'vendor_name',
  'invoice_number',
  'invoice_date',
  'transaction_type',
  'document_type',
  'item_name',
  'sku',
  'hsn_sac',
  'quantity',
  'unit',
  'rate',
  'discount',
  'taxable_amount',
  'gst_rate',
  'cgst_rate',
  'sgst_rate',
  'igst_rate',
  'cgst_amount',
  'sgst_amount',
  'igst_amount',
  'total_amount',
  'place_of_supply',
  'payment_mode',
  'description',
  'gst_inclusive',
  'rcm',
  'taxability',
] as const;

export type CanonicalImportField = (typeof CANONICAL_IMPORT_FIELDS)[number];

export const FIELD_ALIASES: Record<CanonicalImportField, string[]> = {
  customer_name: ['customer', 'customer name', 'party', 'party name', 'buyer', 'client'],
  vendor_name: ['vendor', 'vendor name', 'supplier', 'supplier name'],
  invoice_number: ['invoice', 'invoice no', 'invoice number', 'bill no', 'bill number', 'invoice id'],
  invoice_date: ['date', 'invoice date', 'bill date', 'transaction date'],
  transaction_type: ['type', 'transaction type', 'voucher type', 'document type', 'supply type', 'supply type code'],
  document_type: ['document type', 'doc type', 'document type code', 'voucher'],
  item_name: ['item', 'item name', 'product', 'product name', 'description', 'particulars'],
  sku: ['sku', 'item code', 'product code', 'code'],
  hsn_sac: ['hsn', 'hsn code', 'sac', 'sac code', 'hsn/sac'],
  quantity: ['qty', 'quantity', 'units'],
  unit: ['unit', 'uom', 'unit of measure'],
  rate: ['rate', 'price', 'unit price', 'unit rate'],
  discount: ['discount', 'disc', 'discount amount'],
  taxable_amount: ['taxable', 'taxable amount', 'taxable value'],
  gst_rate: ['gst', 'gst %', 'gst rate', 'tax %', 'tax rate'],
  cgst_rate: ['cgst %', 'cgst rate'],
  sgst_rate: ['sgst %', 'sgst rate'],
  igst_rate: ['igst %', 'igst rate'],
  cgst_amount: ['cgst amount', 'cgst amt', 'cgst'],
  sgst_amount: ['sgst amount', 'sgst amt', 'sgst'],
  igst_amount: ['igst amount', 'igst amt', 'igst'],
  total_amount: ['total', 'total amount', 'grand total', 'invoice total', 'net amount'],
  place_of_supply: ['place of supply', 'pos', 'supply state', 'customer state'],
  payment_mode: ['payment mode', 'payment method', 'mode of payment'],
  description: ['description', 'narration', 'remarks', 'notes'],
  gst_inclusive: ['gst inclusive', 'tax inclusive', 'inclusive tax', 'inclusive gst'],
  rcm: ['rcm', 'reverse charge', 'reverse charge mechanism'],
  taxability: ['taxability', 'tax status', 'tax treatment', 'gst treatment', 'supply category'],
};

export function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[₹$€£%]/g, '')
    .replace(/[._\-/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
