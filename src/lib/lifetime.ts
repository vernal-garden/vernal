import { db } from './db';
import { isUsStateCode } from './beta';
import { getServerConfig } from './serverConfig';

export interface LifetimeRow {
  accountId: number;
  email: string;
  participantAt: Date;
  joinedVia: 'invite' | 'guest' | null;
  activeWeeks: string[];
  activeWeekCount: number;
  feedback: { notes: number; quickAnswers: number; surveys: number; total: number };
  surveyCredits: number[];
  qualifies: boolean;
  borderline: boolean;
  residenceState: string | null;
  residenceStateConfirmedAt: Date | null;
  grantEligible: boolean;
}

// Every beta participant with the counts the lifetime tier is decided on,
// counted up to endsAt. With accountId, just that account (none if it is
// not a participant). The one place that decides who qualifies.
export async function listLifetimeRows(endsAt: Date, accountId?: number): Promise<LifetimeRow[]> {
  const params: unknown[] = [endsAt];
  let only = '';
  if (accountId !== undefined) {
    params.push(accountId);
    only = 'AND a.id = $2';
  }
  const result = await db.query<{
    id: number;
    email: string;
    beta_participant_at: Date;
    beta_joined_via: 'invite' | 'guest' | null;
    residence_state: string | null;
    residence_state_confirmed_at: Date | null;
    active_weeks: string[];
    survey_credits: number[];
    notes: number;
    quick_answers: number;
    surveys: number;
  }>(
    `SELECT a.id, a.email, a.beta_participant_at, a.beta_joined_via,
            a.residence_state, a.residence_state_confirmed_at,
            COALESCE((SELECT array_agg(to_char(w.week_start, 'YYYY-MM-DD') ORDER BY w.week_start)
                        FROM beta_active_weeks w
                       WHERE w.account_id = a.id AND w.first_active_at < $1), '{}') AS active_weeks,
            COALESCE((SELECT array_agg(s.survey ORDER BY s.survey)
                        FROM beta_survey_credits s
                       WHERE s.account_id = a.id), '{}') AS survey_credits,
            (SELECT COUNT(*)::int FROM feedback_submissions f
              WHERE f.user_id = a.id
                AND f.created_at >= a.beta_participant_at AND f.created_at < $1) AS notes,
            (SELECT COUNT(*)::int FROM micro_feedback_responses m
              WHERE m.account_id = a.id
                AND m.created_at >= a.beta_participant_at AND m.created_at < $1) AS quick_answers,
            (SELECT COUNT(*)::int FROM beta_survey_credits s
              WHERE s.account_id = a.id) AS surveys
       FROM accounts a
      WHERE a.beta_participant_at IS NOT NULL ${only}
      ORDER BY a.beta_participant_at DESC, a.id DESC`,
    params,
  );

  return result.rows.map((r) => {
    const activeWeekCount = r.active_weeks.length;
    const total = r.notes + r.quick_answers + r.surveys;
    const qualifies = activeWeekCount >= 3 && total >= 3;
    return {
      accountId: r.id,
      email: r.email,
      participantAt: r.beta_participant_at,
      joinedVia: r.beta_joined_via,
      activeWeeks: r.active_weeks,
      activeWeekCount,
      feedback: { notes: r.notes, quickAnswers: r.quick_answers, surveys: r.surveys, total },
      surveyCredits: r.survey_credits,
      qualifies,
      borderline: activeWeekCount === 2 && total === 2,
      residenceState: r.residence_state,
      residenceStateConfirmedAt: r.residence_state_confirmed_at,
      grantEligible: qualifies && isUsStateCode(r.residence_state),
    };
  });
}

// Whether to ask this account which state they live in: a participant who
// qualifies, from lifetimeStateAskFrom until the grant is applied. Answering
// doesn't change it; the Subscription row shows the answer.
export async function lifetimeStateAsk(
  accountId: number,
  participantAt: Date | null,
  now: Date = new Date(),
): Promise<boolean> {
  if (participantAt === null) return false;
  const { lifetimeStateAskFrom, lifetimeGrantAppliedAt, betaEndsAt } = getServerConfig();
  if (now < lifetimeStateAskFrom) return false;
  if (lifetimeGrantAppliedAt !== null && now >= lifetimeGrantAppliedAt) return false;
  return (await listLifetimeRows(betaEndsAt, accountId))[0]?.qualifies === true;
}
