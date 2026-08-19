import { z } from "zod";

export const FIELD_STATES = [
  "MISSING", "CONFLICT", "CONFIRMED_BY_SOURCE", "CONFIRMED_BY_MANAGER",
  "CONFIRMED_BY_RULE", "CONFIRMED_BY_VERIFIED_CALCULATION", "NOT_APPLICABLE", "CONFIRMED_ZERO",
];
export const CANONICAL_STATUSES = ["DRAFT", "VALIDATED", "CONFIRMED", "SUPERSEDED"];
export const SCHEDULE_TYPES = ["SUPPLIER_ITEM_PAYMENT", "CLIENT_PAYMENT"];

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().finite().nullable().optional();
const nonnegativeNullableNumber = z.number().finite().nonnegative().nullable().optional();
const fieldStateSchema = z.enum(FIELD_STATES);
const utcIsoTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

const lineageEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  sourceType: z.string().min(1),
  sourceFileId: nullableString,
  sourceFileName: nullableString,
  sourceSheet: nullableString,
  sourceRange: nullableString,
  sourceFormula: nullableString,
  sourceRole: z.string().min(1),
  authorityClass: z.string().min(1),
  ruleId: nullableString,
  ruleVersion: nullableString,
  capturedAt: utcIsoTimestampSchema,
  note: nullableString,
}).passthrough().superRefine((value, ctx) => {
  if (!String(value.sourceFileId || "").trim() && !String(value.sourceFileName || "").trim()) {
    ctx.addIssue({ code: "custom", message: "sourceFileId or sourceFileName is required" });
  }
});

const fieldMetaSchema = z.object({
  entityType: z.string().min(1),
  entityId: nullableString,
  fieldCode: z.string().min(1),
  state: fieldStateSchema,
  lineageRefs: z.array(z.string()),
  ruleRefs: z.array(z.string()),
  decisionRefs: z.array(z.string()),
  note: nullableString,
}).strict();

const managerDecisionSchema = z.object({
  decisionId: z.string().min(1),
  entityType: nullableString,
  entityId: nullableString,
  fieldCode: z.string().min(1),
  decisionType: z.string().min(1),
  value: z.unknown().optional(),
  reason: nullableString,
  decidedAt: utcIsoTimestampSchema,
  decidedBy: z.string().min(1),
  sourceQuestionId: nullableString,
}).strict();

const ruleBindingSchema = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.string().min(1),
}).passthrough();

const paymentAllocationSchema = z.object({
  allocationId: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  baseType: z.string().min(1),
  percent: nonnegativeNullableNumber,
  amount: nonnegativeNullableNumber,
  zeroConfirmed: z.boolean(),
  confirmationState: fieldStateSchema,
  lineageRefs: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.percent == null && value.amount == null) ctx.addIssue({ code: "custom", message: "percent or amount is required" });
  if ((value.percent === 0 || value.amount === 0) && value.zeroConfirmed !== true) ctx.addIssue({ code: "custom", message: "explicit zero requires zeroConfirmed=true" });
});

const paymentStageSchema = z.object({
  stageId: z.string().min(1),
  order: z.number().int().positive(),
  stageCode: nullableString,
  label: nullableString,
  dueCondition: nullableString,
  percent: nonnegativeNullableNumber,
  amount: nonnegativeNullableNumber,
  zeroConfirmed: z.boolean(),
  confirmationState: fieldStateSchema,
  lineageRefs: z.array(z.string().min(1)),
  allocations: z.array(paymentAllocationSchema),
}).strict().superRefine((value, ctx) => {
  if (value.percent == null && value.amount == null && value.allocations.length === 0) ctx.addIssue({ code: "custom", message: "stage needs percent, amount or allocations" });
  if ((value.percent === 0 || value.amount === 0) && value.zeroConfirmed !== true) ctx.addIssue({ code: "custom", message: "explicit zero requires zeroConfirmed=true" });
});

const paymentSchemeSchema = z.object({
  schemeId: z.string().min(1),
  name: nullableString,
  applicability: z.unknown().optional(),
  active: z.boolean(),
  lineageRefs: z.array(z.string().min(1)),
  stages: z.array(paymentStageSchema).min(1),
}).strict();

export const paymentScheduleSchema = z.object({
  scheduleId: z.string().min(1),
  dealId: z.string().min(1),
  scheduleType: z.enum(SCHEDULE_TYPES),
  activeSchemeId: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  confirmationState: fieldStateSchema,
  lineageRefs: z.array(z.string().min(1)),
  schemes: z.array(paymentSchemeSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const active = value.schemes.filter((scheme) => scheme.active === true);
  if (active.length !== 1) ctx.addIssue({ code: "custom", path: ["schemes"], message: "exactly one active scheme is required" });
  if (active.length === 1 && active[0].schemeId !== value.activeSchemeId) ctx.addIssue({ code: "custom", path: ["activeSchemeId"], message: "activeSchemeId must reference the active scheme" });
});

const logisticsSchema = z.object({
  incoterms: nullableString,
  chinaRoute: nullableString,
  borderCrossing: nullableString,
  destinationCity: nullableString,
  transportMode: nullableString,
  deliveryDays: z.unknown().optional(),
  productionDays: z.unknown().optional(),
}).passthrough();

const dealSchema = z.object({
  client: nullableString,
  manager: nullableString,
  partner: nullableString,
  scheme: nullableString,
  quoteCurrency: nullableString,
  validityDays: z.number().int().nullable().optional(),
  logistics: logisticsSchema.optional(),
  paymentTermsText: nullableString,
  comment: nullableString,
}).passthrough();

const itemSchema = z.object({
  itemId: z.string().min(1),
  itemNumber: z.number().int().positive(),
  supplier: nullableString,
  name: nullableString,
  article: nullableString,
  category: nullableString,
  subcategory: nullableString,
  ageClass: nullableString,
  tnVed: nullableString,
  quantity: nonnegativeNullableNumber,
  quantityUnit: nullableString,
  priceType: nullableString,
  unitPrice: nonnegativeNullableNumber,
  priceCurrency: nullableString,
  batchAmount: nonnegativeNullableNumber,
  priceWithoutVat: nullableNumber,
  chinaVatRate: nullableNumber,
  priceWithVat: nullableNumber,
  vatRefundStatus: nullableString,
  vatRefundExpenseCny: nullableNumber,
  netWeightKg: nonnegativeNullableNumber,
  grossWeightKg: nonnegativeNullableNumber,
  volumeM3: nonnegativeNullableNumber,
  packages: nonnegativeNullableNumber,
  importVatRate: nonnegativeNullableNumber,
  dutyMethod: nullableString,
  dutyRate: nonnegativeNullableNumber,
  dutyCurrency: nullableString,
  productionDays: z.unknown().optional(),
}).passthrough();

const expenseSchema = z.object({
  expenseId: z.string().min(1),
  itemId: nullableString,
  level: nullableString,
  category: nullableString,
  article: nullableString,
  calculationBucket: nullableString,
  amount: nonnegativeNullableNumber,
  currency: nullableString,
  allocationMethod: nullableString,
  includeInCalculation: z.boolean(),
  showToClient: z.boolean().nullable().optional(),
}).passthrough();

const allocationSchema = z.object({
  allocationId: z.string().min(1),
  expenseId: z.string().min(1),
  itemId: z.string().min(1),
  share: z.number().finite().min(0).max(1).nullable().optional(),
  amountCny: nonnegativeNullableNumber,
  amountRub: nonnegativeNullableNumber,
  method: nullableString,
  confirmationState: fieldStateSchema.optional(),
  lineageRefs: z.array(z.string()).optional(),
}).passthrough();

const rateSchema = z.object({
  rateId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  value: nullableNumber,
  confirmed: z.boolean(),
  purpose: nullableString,
}).passthrough();

export const canonicalDealSchema = z.object({
  contractVersion: z.literal("1.0"),
  canonicalId: z.string().min(1),
  dealId: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(CANONICAL_STATUSES),
  createdAt: utcIsoTimestampSchema,
  createdBy: z.string().min(1),
  deal: dealSchema,
  items: z.array(itemSchema).min(1),
  expenses: z.array(expenseSchema),
  allocations: z.array(allocationSchema),
  rates: z.array(rateSchema),
  paymentSchedules: z.array(paymentScheduleSchema),
  managerDecisions: z.array(managerDecisionSchema),
  ruleBindings: z.array(ruleBindingSchema),
  fieldMeta: z.array(fieldMetaSchema),
  lineage: z.array(lineageEvidenceSchema),
}).strict();
