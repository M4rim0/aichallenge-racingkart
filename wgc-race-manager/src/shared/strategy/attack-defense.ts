/**
 * 攻撃・防衛の必要ペース（§8.6, §8.7、D-052）。
 *
 * 残り走行可能時間 R の間に、各チームは R / P 周進むと仮定する（P：予測ペース）。
 * 位置の差 G は推定走行位置 Q の差（小数の周）。
 *
 * 攻撃（前方チーム、ペース Pt、位置差 G = Q_相手 − Q_自）：
 *   終了時に「同じ位置に並ぶ」（追いつく）ペース P_req = 1 / (1/Pt + G/R)
 *   「追い抜く」（相手より前の位置になる）には P_req より短いペースが必要（境界値は同じ、不等号が異なる）
 * 防衛（後方チーム、ペース Pb、リード G = Q_自 − Q_相手）：
 *   終了時に「並ばれる」境界 P_req = 1 / (1/Pb − G/R)
 *   追いつかれない（並ばれない）には P_req より短いペース、抜かれないには P_req 以下のペースが必要
 *   分母 ≤ 0 なら、相手のペースでは残り時間内に追いつけない（自チームが走行しなくても）
 *
 * いずれも推定値。周回の完了（通過）による離散的な順位判定とは一致しない場合がある。
 */

export type AttackStatus =
  | 'OK'
  /** 残り走行可能時間がない */
  | 'NO_TIME'
  /** 相手または自チームのペース・位置がデータ不足 */
  | 'NO_DATA'
  /** 既に相手より前の位置で、自チームが走行しなくても終了時に前にいる（分母 ≤ 0） */
  | 'AHEAD_EVEN_IF_STOPPED'

export interface AttackResult {
  targetTeamId: number
  status: AttackStatus
  /** 位置差 G（周、推定）= Q_相手 − Q_自 */
  gapLaps: number | null
  targetPaceMs: number | null
  remainingDriveMs: number
  /** 終了時に並ぶ（追いつく）ためのラップタイム（ms）。これより短いと追い抜く */
  catchUpPaceMs: number | null
  /** 自チームの予測ペース（比較用） */
  ownPaceMs: number | null
  /** catchUpPaceMs − 自チームのペース（負ならペースアップが必要） */
  paceMarginMs: number | null
}

export type DefenseStatus =
  | 'OK'
  | 'NO_TIME'
  | 'NO_DATA'
  /** 相手のペースでは、自チームが走行しなくても残り時間内に追いつけない（分母 ≤ 0） */
  | 'SAFE_EVEN_IF_STOPPED'

export interface DefenseResult {
  threatTeamId: number
  status: DefenseStatus
  /** リード G（周、推定）= Q_自 − Q_相手 */
  leadLaps: number | null
  threatPaceMs: number | null
  remainingDriveMs: number
  /** 終了時に並ばれる境界のラップタイム（ms）。これより短ければ追いつかれない、これ以下なら抜かれない */
  limitPaceMs: number | null
  ownPaceMs: number | null
  /** limitPaceMs − 自チームのペース（負ならペースアップが必要） */
  paceMarginMs: number | null
}

const valid = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0

export function computeAttack(args: {
  targetTeamId: number
  ownQ: number | null
  targetQ: number | null
  targetPaceMs: number | null
  ownPaceMs: number | null
  remainingDriveMs: number
}): AttackResult {
  const base = {
    targetTeamId: args.targetTeamId,
    targetPaceMs: args.targetPaceMs,
    remainingDriveMs: args.remainingDriveMs,
    ownPaceMs: args.ownPaceMs
  }
  if (!(args.remainingDriveMs > 0)) {
    return { ...base, status: 'NO_TIME', gapLaps: null, catchUpPaceMs: null, paceMarginMs: null }
  }
  if (args.ownQ === null || args.targetQ === null || !valid(args.targetPaceMs)) {
    return { ...base, status: 'NO_DATA', gapLaps: null, catchUpPaceMs: null, paceMarginMs: null }
  }
  const g = args.targetQ - args.ownQ
  const inv = 1 / args.targetPaceMs + g / args.remainingDriveMs
  if (!(inv > 0)) {
    return { ...base, status: 'AHEAD_EVEN_IF_STOPPED', gapLaps: g, catchUpPaceMs: null, paceMarginMs: null }
  }
  const p = 1 / inv
  return {
    ...base,
    status: 'OK',
    gapLaps: g,
    catchUpPaceMs: p,
    paceMarginMs: valid(args.ownPaceMs) ? p - args.ownPaceMs : null
  }
}

export function computeDefense(args: {
  threatTeamId: number
  ownQ: number | null
  threatQ: number | null
  threatPaceMs: number | null
  ownPaceMs: number | null
  remainingDriveMs: number
}): DefenseResult {
  const base = {
    threatTeamId: args.threatTeamId,
    threatPaceMs: args.threatPaceMs,
    remainingDriveMs: args.remainingDriveMs,
    ownPaceMs: args.ownPaceMs
  }
  if (!(args.remainingDriveMs > 0)) {
    return { ...base, status: 'NO_TIME', leadLaps: null, limitPaceMs: null, paceMarginMs: null }
  }
  if (args.ownQ === null || args.threatQ === null || !valid(args.threatPaceMs)) {
    return { ...base, status: 'NO_DATA', leadLaps: null, limitPaceMs: null, paceMarginMs: null }
  }
  const g = args.ownQ - args.threatQ
  const inv = 1 / args.threatPaceMs - g / args.remainingDriveMs
  if (!(inv > 0)) {
    return { ...base, status: 'SAFE_EVEN_IF_STOPPED', leadLaps: g, limitPaceMs: null, paceMarginMs: null }
  }
  const p = 1 / inv
  return {
    ...base,
    status: 'OK',
    leadLaps: g,
    limitPaceMs: p,
    paceMarginMs: valid(args.ownPaceMs) ? p - args.ownPaceMs : null
  }
}
