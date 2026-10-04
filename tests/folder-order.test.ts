import { describe, expect, it } from 'vitest';
import { validateFolderOrder } from '../src/worker/folder-order';
import configuredOrder from '../config/folder-order.json';

describe('folder order configuration', () => {
  it('accepts independent area orders, including empty lists and the repository configuration', () => {
    expect(validateFolderOrder({ active: ['second', 'first'], archive: ['first'] }))
      .toEqual({ active: ['second', 'first'], archive: ['first'] });
    expect(validateFolderOrder({ active: [], archive: [] })).toEqual({ active: [], archive: [] });
    expect(() => validateFolderOrder(configuredOrder)).not.toThrow();
  });

  it.each([
    null, [], {}, { active: [] }, { active: [], archive: [], typo: [] },
    { active: 'first', archive: [] }, { active: ['same', 'same'], archive: [] },
    { active: [], archive: [1] }, { active: [''], archive: [] },
    { active: ['a/b'], archive: [] }, { active: ['.hidden'], archive: [] },
  ])('rejects malformed configuration without defaulting to name order: %j', value => {
    expect(() => validateFolderOrder(value)).toThrow('folder-order.json');
  });
});
