import { describe, expect, it } from 'vitest';
import { testOrderLabel } from './index';

describe('testOrderLabel', () => {
  it('reads like the PRD example: test, region and side', () => {
    expect(testOrderLabel({ name: 'MRI', region: 'Knee', side: 'right', views: [] }, 'en')).toBe(
      'MRI knee, right',
    );
    expect(testOrderLabel({ name: 'MRI', region: 'Knee', side: 'right', views: [] }, 'hi')).toBe(
      'MRI knee, दायाँ',
    );
  });

  it('adds X-ray views and keeps abbreviations in capitals', () => {
    expect(
      testOrderLabel(
        { name: 'X-ray', region: 'Knee', side: 'both', views: ['AP', 'Lateral'] },
        'en',
      ),
    ).toBe('X-ray knee, both sides (AP, Lateral)');
    expect(testOrderLabel({ name: 'CT', region: 'HRCT chest', side: 'na', views: [] }, 'en')).toBe(
      'CT HRCT chest',
    );
  });

  it('prints a blood test or a free-text test as written', () => {
    expect(
      testOrderLabel(
        { name: ' Complete blood count (CBC) ', region: null, side: 'na', views: [] },
        'hi',
      ),
    ).toBe('Complete blood count (CBC)');
  });
});
