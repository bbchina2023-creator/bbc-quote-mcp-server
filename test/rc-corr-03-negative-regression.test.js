import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { canonicalDealSchema } from "../src/canonical-schema.js";

function baseCanonical() {
  return {
    contractVersion: "1.0",
    canonicalId: "CAN-1",
    dealId: "DEAL-1",
    revision: 1,
    status: "VALIDATED",
    createdAt: "2026-08-20T00:00:00Z",
    createdBy: "TEST",
    deal: { scheme: "CLIENT_IMPORTER_BBC_EXPORTER" },
    items: [{
      itemId: "ITEM-1", itemNumber: 1, name: "Item", quantity: 2,
      quantityUnit: "pcs", priceType: "UNIT", unitPrice: 50,
      priceCurrency: "CNY", batchAmount: 100,
    }],
    expenses: [], allocations: [], rates: [], paymentSchedules: [],
    managerDecisions: [],
    ruleBindings: [{
      ruleId: "COM-001", ruleVersion: "2026-08-05",
      fieldCodes: ["commission.percent"],
      schemeCodes: ["CLIENT_IMPORTER_BBC_EXPORTER"],
    }],
    fieldMeta: [],
    lineage: [],
  };
}

test("RC-CORR-03 blocks quantity × unitPrice mismatch", () => {
  const canonical = baseCanonical();
  canonical.items[0].batchAmount = 99;
  assert.equal(canonicalDealSchema.safeParse(canonical).success, false);
});

test("RC-CORR-03 blocks a manager decision bound to another field", () => {
  const canonical = baseCanonical();
  canonical.managerDecisions.push({
    decisionId: "DEC-1", entityType: "DEAL", entityId: "DEAL-1",
    fieldCode: "validityDays", decisionType: "CONFIRM", value: 10,
    reason: null, decidedAt: "2026-08-20T00:00:00Z", decidedBy: "manager",
    sourceQuestionId: null,
  });
  canonical.fieldMeta.push({
    entityType: "DEAL", entityId: "DEAL-1", fieldCode: "quoteCurrency",
    state: "CONFIRMED_BY_MANAGER", lineageRefs: [], ruleRefs: [],
    decisionRefs: ["DEC-1"], note: null,
  });
  assert.equal(canonicalDealSchema.safeParse(canonical).success, false);
});

test("RC-CORR-03 blocks arbitrary lineage authority strings", () => {
  const canonical = baseCanonical();
  canonical.lineage.push({
    evidenceId: "E-1", sourceType: "MADE_UP", sourceFileId: "F-1",
    sourceFileName: null, sourceSheet: null, sourceRange: null,
    sourceFormula: null, sourceRole: "UNKNOWN", authorityClass: "PRIMARY_SOURCE",
    ruleId: null, ruleVersion: null, capturedAt: "2026-08-20T00:00:00Z", note: null,
  });
  assert.equal(canonicalDealSchema.safeParse(canonical).success, false);
});

test("RC-CORR-03 blocks unresolved payment schedules and missing lineage", () => {
  const canonical = baseCanonical();
  canonical.paymentSchedules.push({
    scheduleId: "PAY-1", dealId: "DEAL-1", scheduleType: "CLIENT_PAYMENT",
    activeSchemeId: "SCHEME-1", currency: "CNY", confirmationState: "MISSING",
    lineageRefs: [], schemes: [{
      schemeId: "SCHEME-1", name: "100%", active: true, lineageRefs: [],
      stages: [{ stageId: "STAGE-1", order: 1, percent: 100, amount: null,
        zeroConfirmed: false, confirmationState: "MISSING", lineageRefs: [], allocations: [] }],
    }],
  });
  assert.equal(canonicalDealSchema.safeParse(canonical).success, false);
});

test("RC-CORR-03 blocks a rule reference not applicable to the field", () => {
  const canonical = baseCanonical();
  canonical.fieldMeta.push({
    entityType: "DEAL", entityId: "DEAL-1", fieldCode: "validityDays",
    state: "CONFIRMED_BY_RULE", lineageRefs: [],
    ruleRefs: ["COM-001@2026-08-05"], decisionRefs: [], note: null,
  });
  assert.equal(canonicalDealSchema.safeParse(canonical).success, false);
});

test("RC-CORR-03 blocks a multi-item expense that would disappear", () => {
  const canonical = baseCanonical();
  canonical.items.push({
    itemId: "ITEM-2", itemNumber: 2, name: "Item 2", quantity: 1,
    quantityUnit: "pcs", priceType: "UNIT", unitPrice: 10,
    priceCurrency: "CNY", batchAmount: 10,
  });
  canonical.expenses.push({
    expenseId: "EXP-1", itemId: null, level: "DEAL", category: "logistics",
    article: "freight", calculationBucket: "internationalLogistics", amount: 10,
    currency: "CNY", allocationMethod: "EXPLICIT_AMOUNT",
    includeInCalculation: true, showToClient: true,
  });
  assert.equal(canonicalDealSchema.safeParse(canonical).success, false);
});

test("RC-CORR-03 Worker fails closed on an unexpected backend contour", () => {
  const source = fs.readFileSync(new URL("../src/staging-contour-rc.js", import.meta.url), "utf8");
  assert.match(source, /BACKEND_CONTOUR_VERSION_MISMATCH/);
  assert.match(source, /EXPECTED_BACKEND_CONTOUR_VERSION\s*=\s*"1\.0\.9-rc-corr-26"/);
});

test("RC-CORR-03 Apps Script binds snapshot metadata and performs structural PDF checks", () => {
  const source = fs.readFileSync(new URL("../apps-script/BBC_KP_Generator_Code_v4.2.0_RELEASE_C_RC-CORR-03.gs", import.meta.url), "utf8");
  assert.match(source, /createdAt:snapshot\.createdAt,createdBy:snapshot\.createdBy,status:snapshot\.status,immutable:snapshot\.immutable/);
  assert.match(source, /PDF_HEADER_INVALID/);
  assert.match(source, /PDF_EOF_MISSING/);
});
