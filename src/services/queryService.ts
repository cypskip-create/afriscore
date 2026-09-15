import { getBusiness } from "./businessService";
import { computeFinancialProfile } from "./analyticsService";
import {
  getOverdueInvoices,
  getCashFlowForecast,
  getUnusualTransactions,
  getCustomerConcentration,
} from "./insightsService";

/**
 * Query Service — the front door the spec's "AI agent vision" (section 21)
 * describes: a person asks a plain-language question, the platform
 * answers using its own structured data.
 *
 * This is intentionally NOT wired to a real language model — there's no
 * API key available to call one, and more importantly, the spec is
 * explicit that answers should come from structured data, not model
 * guesswork. What's here is honest keyword-intent matching: narrower
 * than real NLU, but every answer is 100% grounded in real data, with
 * zero hallucination risk. Swap the matchIntent() function for a real
 * LLM call later if broader phrasing coverage is worth the trade-off —
 * everything downstream (the actual data lookups) doesn't need to change.
 */

export interface QueryAnswer {
  question: string;
  matched_intent: string | null;
  answer: string;
  data: unknown;
}

interface IntentDef {
  intent: string;
  keywords: string[][]; // each inner array is a set of keywords that ALL must appear
}

const INTENTS: IntentDef[] = [
  { intent: "overdue_invoices", keywords: [["overdue"], ["invoice", "invoices"]] },
  { intent: "cash_flow_forecast", keywords: [["cash", "forecast", "cashflow"]] },
  { intent: "unusual_transactions", keywords: [["unusual", "suspicious", "outlier", "anomal"], ["transaction"]] },
  { intent: "customer_concentration", keywords: [["customer", "client"], ["depend", "concentrat", "biggest", "largest"]] },
  { intent: "financial_profile", keywords: [["revenue", "profile", "financial", "income"]] },
  { intent: "trust_score", keywords: [["trust", "score", "verified", "verification"]] },
];

function matchIntent(question: string): string | null {
  const q = question.toLowerCase();
  for (const def of INTENTS) {
    const allGroupsMatch = def.keywords.every((group) => group.some((kw) => q.includes(kw)));
    if (allGroupsMatch) return def.intent;
  }
  return null;
}

export async function answerQuestion(businessId: string, question: string): Promise<QueryAnswer> {
  const business = await getBusiness(businessId);
  if (!business) throw new Error("business_not_found");

  const intent = matchIntent(question);

  switch (intent) {
    case "overdue_invoices": {
      const data = await getOverdueInvoices(businessId);
      const answer =
        data.length === 0
          ? "No overdue invoices."
          : `${data.length} overdue invoice(s), totaling ${data.reduce((s, i) => s + i.amount, 0).toFixed(2)} KES. Most overdue: ${data[0].customer_reference} at ${data[0].days_overdue} days.`;
      return { question, matched_intent: intent, answer, data };
    }

    case "cash_flow_forecast": {
      const data = await getCashFlowForecast(businessId);
      const answer = `Based on ${data.based_on_days} day(s) of history (${data.confidence} confidence), projected net cash flow over the next 30 days is ${data.forecast_next_30d.toFixed(2)} KES.`;
      return { question, matched_intent: intent, answer, data };
    }

    case "unusual_transactions": {
      const data = await getUnusualTransactions(businessId);
      const answer =
        data.length === 0
          ? "No statistically unusual transactions found."
          : `${data.length} transaction(s) more than 2 standard deviations from the business's typical size — largest deviation: ${data[0].amount} KES.`;
      return { question, matched_intent: intent, answer, data };
    }

    case "customer_concentration": {
      const data = await getCustomerConcentration(businessId);
      const answer =
        data.length === 0
          ? "No paid invoices yet to measure customer concentration."
          : `Top customer is ${data[0].customer_reference}, accounting for ${data[0].share_of_total_pct}% of realized revenue.`;
      return { question, matched_intent: intent, answer, data };
    }

    case "financial_profile": {
      const data = await computeFinancialProfile(businessId);
      const answer = `Total revenue: ${data.total_revenue} KES. Total expenses: ${data.total_expenses} KES. Net cash flow: ${data.net_cash_flow} KES.`;
      return { question, matched_intent: intent, answer, data };
    }

    case "trust_score": {
      const answer = `${business.legal_name} has a trust score of ${business.trust_score}/100 and status "${business.status}".`;
      return { question, matched_intent: intent, answer, data: { trust_score: business.trust_score, status: business.status } };
    }

    default:
      return {
        question,
        matched_intent: null,
        answer:
          "I couldn't match that to a known question. Try asking about: overdue invoices, cash flow forecast, unusual transactions, customer concentration, financial profile, or trust score.",
        data: null,
      };
  }
}