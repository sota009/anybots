import { expect, it } from 'vitest';
import { notificationBudgetOptions } from '../src/notification-budget.js';

it('keeps bounded defaults and reads explicit operator limits', () => {
  expect(notificationBudgetOptions({})).toEqual({ daily: 20, monthly: 100 });
  expect(notificationBudgetOptions({ NOTIFICATION_DAILY_LIMIT: '200', NOTIFICATION_MONTHLY_LIMIT: '2000' }))
    .toEqual({ daily: 200, monthly: 2000 });
  expect(notificationBudgetOptions({ NOTIFICATION_DAILY_LIMIT: '50' })).toEqual({ daily: 50, monthly: 100 });
});

it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 200', '200 ', '200x', '9007199254740992'])(
  'rejects invalid budget configuration %j without exposing the supplied value', value => {
    for (const name of ['NOTIFICATION_DAILY_LIMIT', 'NOTIFICATION_MONTHLY_LIMIT']) {
      expect(() => notificationBudgetOptions({ [name]: value })).toThrow(`Invalid ${name}: expected a positive safe integer`);
    }
  },
);
