import { getGenerativeModel, InferenceMode, Schema } from 'firebase/ai';
import { getFirebase } from './firebase';
import type { CloudAuditor, CloudReport } from './types';

// The cloud is an explicit choice (ONLY_IN_CLOUD), used only after the user approves
// the payload in the Privacy Firewall. It never sees raw descriptions.

const schema = Schema.object({
  properties: {
    findings: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string(),
          detail: Schema.string(),
          severity: Schema.enumString({ enum: ['low', 'medium', 'high'] }),
        },
      }),
    }),
    questionsForAccountant: Schema.array({ items: Schema.string() }),
    narrative: Schema.string(),
  },
});

const SYSTEM = `You are a careful bookkeeping reviewer. You receive an anonymized summary: vendors are aliases like Vendor_A,
amounts are integer cents, and "signals" were computed by deterministic code. Explain each signal, rank what matters,
write questions an accountant should ask, and a short narrative. Refer to vendors only by their alias. Do not invent amounts.
Never write "cents" in your answer: show every amount in US dollars by moving the decimal point two places
(2743738 cents -> $27,437.38).`;

export function createCloudAuditor(): CloudAuditor {
  return {
    async audit(approvedPayloadJson, modelName) {
      const model = getGenerativeModel(getFirebase().ai, {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          model: modelName,
          systemInstruction: SYSTEM,
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
        },
      });
      // the same approved payload is resent only on "high demand" (500/503); nothing else changes between tries
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await model.generateContent(approvedPayloadJson);
          return JSON.parse(res.response.text()) as CloudReport;
        } catch (err) {
          if (attempt >= 3 || !/\[(500|503)\b/.test(String(err))) throw err;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    },
    async draftReply(packItemJson, modelName) {
      const model = getGenerativeModel(getFirebase().ai, {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          model: modelName,
          systemInstruction:
            'You are an accountant reviewing a single pseudonymized alert from a client review pack. ' +
            'Vendors appear only as aliases like Vendor_A. Write a concise 2-sentence accounting response ' +
            'that answers the client question, references the vendor only by its alias, and states the ' +
            'recommended ledger treatment or supporting document required.',
        },
      });
      const res = await model.generateContent(packItemJson);
      return res.response.text().trim();
    },
  };
}
