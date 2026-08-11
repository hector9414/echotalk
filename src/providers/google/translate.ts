import { v2 } from '@google-cloud/translate';
import { GOOGLE_CLOUD_PROJECT_ID } from '../../config';
import type { Translator } from '../types';

const { Translate } = v2;

let sharedClient: InstanceType<typeof Translate> | undefined;
function getTranslateClient(): InstanceType<typeof Translate> {
  if (!sharedClient) {
    sharedClient = new Translate({ projectId: GOOGLE_CLOUD_PROJECT_ID });
  }
  return sharedClient;
}

export class GoogleTranslator implements Translator {
  private readonly client: InstanceType<typeof Translate>;

  constructor(client: InstanceType<typeof Translate> = getTranslateClient()) {
    this.client = client;
  }

  async translate(text: string, fromCode: string, toCode: string): Promise<string> {
    if (!text.trim()) return '';
    const [translation] = await this.client.translate(text, { from: fromCode, to: toCode });
    return translation;
  }
}
