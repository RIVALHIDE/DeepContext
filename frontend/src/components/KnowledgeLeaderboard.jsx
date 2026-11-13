import { Award, Crown, Medal, Trophy } from 'lucide-react';

const TIERS = [
  {
    key: 'gold',
    label: 'Gold',
    threshold: 10,
    icon: Crown,
    color: '#FCD34D',
    bg: 'rgba(252, 211, 77, 0.12)',
    border: 'rgba(252, 211, 77, 0.3)',
  },
  {
    key: 'silver',
    label: 'Silver',
    threshold: 5,
    icon: Medal,
    color: '#64748B',
    bg: 'rgba(100, 116, 139, 0.09)',
    border: 'rgba(100, 116, 139, 0.22)',
  },
  {
    key: 'bronze',
    label: 'Bronze',
    threshold: 1,
    icon: Award,
    color: '#D97706',
    bg: 'rgba(217, 119, 6, 0.1)',
    border: 'rgba(217, 119, 6, 0.25)',
  },
];

function getTier(contributions) {
  for (const tier of TIERS) {
    if (contributions >= tier.threshold) return tier;
  }
  return null;
}

// Placeholder leaderboard data — wired to a real endpoint when available
const DEFAULT_LEADERBOARD = [
  { user_id: 'anon_1', display_name: 'Alex Chen', contributions: 14, team: 'Platform' },
  { user_id: 'anon_2', display_name: 'Sam Rivera', contributions: 8, team: 'Platform' },
  { user_id: 'anon_3', display_name: 'Jordan Lee', contributions: 5, team: 'Platform' },
  { user_id: 'anon_4', display_name: 'Riley Park', contributions: 3, team: 'Platform' },
  { user_id: 'anon_5', display_name: 'Casey Kim', contributions: 1, team: 'Platform' },
];

export default function KnowledgeLeaderboard({ users = DEFAULT_LEADERBOARD }) {
  const sorted = [...users].sort((a, b) => b.contributions - a.contributions);

  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-2 mb-3"
        style={{ color: 'var(--dc-text-muted)' }}
      >
        <Trophy size={12} />
        <h3 className="text-[10px] font-semibold uppercase tracking-widest">
          Knowledge Leaderboard
        </h3>
      </div>

      {sorted.map((user, idx) => {
        const tier = getTier(user.contributions);
        if (!tier) return null;

        const TierIcon = tier.icon;
        const isTopUser = idx === 0;

        return (
          <div
            key={user.user_id ?? idx}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-all"
            style={{
              background: isTopUser ? tier.bg : 'transparent',
              border: `1px solid ${isTopUser ? tier.border : 'transparent'}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tier.bg;
              e.currentTarget.style.border = `1px solid ${tier.border}`;
            }}
            onMouseLeave={(e) => {
              if (!isTopUser) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.border = '1px solid transparent';
              }
            }}
          >
            <div
              className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
              style={{ background: tier.bg, border: `1px solid ${tier.border}` }}
            >
              <TierIcon size={13} style={{ color: tier.color }} />
            </div>

            <div className="flex-1 min-w-0">
              <p
                className="text-xs font-medium truncate"
                style={{ color: 'var(--dc-text-primary)' }}
              >
                {user.display_name}
              </p>
              <p
                className="text-[10px] truncate"
                style={{ color: 'var(--dc-text-muted)' }}
              >
                {user.team}
              </p>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <span
                className="text-[10px] font-bold"
                style={{ color: tier.color }}
              >
                {tier.label}
              </span>
              <span
                className="text-[10px]"
                style={{ color: 'var(--dc-text-muted)' }}
              >
                {user.contributions}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
