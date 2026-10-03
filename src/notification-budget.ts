import { z } from 'zod';

const budgetSchema = z.strictObject({ daily: z.number().int().positive(), monthly: z.number().int().positive() });
export type NotificationBudget = Readonly<z.infer<typeof budgetSchema>>;
export const DEFAULT_NOTIFICATION_BUDGET: NotificationBudget = Object.freeze({ daily: 20, monthly: 100 });

export function validateNotificationBudget(input: NotificationBudget): NotificationBudget {
  const result = budgetSchema.safeParse(input);
  if (!result.success) throw new Error('Invalid notification budget');
  return result.data;
}

/** Operator configuration only. Never echo potentially sensitive env values. */
export function notificationBudgetOptions(env: NodeJS.ProcessEnv = process.env): NotificationBudget {
  const read = (name: string, fallback: number) => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`Invalid ${name}: expected a positive safe integer`);
    }
    return Number(value);
  };
  return validateNotificationBudget({
    daily: read('NOTIFICATION_DAILY_LIMIT', DEFAULT_NOTIFICATION_BUDGET.daily),
    monthly: read('NOTIFICATION_MONTHLY_LIMIT', DEFAULT_NOTIFICATION_BUDGET.monthly),
  });
}
