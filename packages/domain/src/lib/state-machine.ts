import { DomainError } from '@auto-work/contracts';

export type TransitionMap<TState extends string> = Readonly<Record<TState, readonly TState[]>>;

/** 集中校验领域状态转换，API 是否隐藏按钮不能成为唯一安全边界。 */
export function assertTransition<TState extends string>(
  transitions: TransitionMap<TState>,
  from: TState,
  to: TState,
  aggregate: string,
): void {
  if (!transitions[from].includes(to)) {
    throw new DomainError('STATE_TRANSITION_REJECTED', `${aggregate} 不能从 ${from} 转换为 ${to}`, {
      httpStatus: 409,
      retryable: false,
      suggestedAction: 'refresh',
      details: { from, to },
    });
  }
}
