export const planOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "steps",
    "affectedAreas",
    "verification",
    "risks",
    "acceptanceMapping",
    "requiresRiskEvaluation"
  ],
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "doneState"],
        properties: {
          text: { type: "string" },
          doneState: { type: "string" }
        }
      }
    },
    affectedAreas: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    acceptanceMapping: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "evidence"],
        properties: {
          criterion: { type: "string" },
          evidence: { type: "string" }
        }
      }
    },
    requiresRiskEvaluation: { type: "boolean" }
  }
} as const;

export const receiptOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome",
    "summary",
    "filesChanged",
    "commandsRun",
    "checks",
    "unresolvedRisks",
    "finalMessage"
  ],
  properties: {
    outcome: { type: "string", enum: ["success", "blocked", "failed"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    commandsRun: { type: "array", items: { type: "string" } },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "detail"],
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["passed", "failed", "not_run"] },
          detail: { type: "string" }
        }
      }
    },
    unresolvedRisks: { type: "array", items: { type: "string" } },
    finalMessage: { type: "string" }
  }
} as const;
