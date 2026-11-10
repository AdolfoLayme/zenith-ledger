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
write questions an accountant should ask, and a short narrative. Refer to vendors only by their alias. Do not invent amounts.`;

export function createCloudAuditor(): CloudAuditor {
  return {
    async audit(approvedPayloadJson) {
      const model = getGenerativeModel(getFirebase().ai, {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          model: 'gemini-2.5-flash',
          systemInstruction: SYSTEM,
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
        },
      });
      const res = await model.generateContent(approvedPayloadJson);
      return JSON.parse(res.response.text()) as CloudReport;
    },
  };
}
