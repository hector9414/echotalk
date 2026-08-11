import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguageOption, LANGUAGES } from './config';

describe('getLanguageOption', () => {
  it('returns the matching language for a known id', () => {
    const option = getLanguageOption('es-ES');
    assert.equal(option?.id, 'es-ES');
    assert.equal(option?.translateCode, 'es');
  });

  it('returns undefined for an unknown id', () => {
    assert.equal(getLanguageOption('xx-XX'), undefined);
  });

  it('every language has non-empty codes for all three Google APIs', () => {
    for (const lang of LANGUAGES) {
      assert.ok(lang.sttCode, `${lang.id} missing sttCode`);
      assert.ok(lang.translateCode, `${lang.id} missing translateCode`);
      assert.ok(lang.ttsLanguageCode, `${lang.id} missing ttsLanguageCode`);
    }
  });
});
