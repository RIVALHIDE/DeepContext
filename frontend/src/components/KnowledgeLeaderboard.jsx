import { useEffect, useState } from 'react';
import { Award, Crown, Medal, Trophy, LoaderCircle } from 'lucide-react';
import api from '../utils/api.util';

const TIERS = [
  {
    key: 'gold',
    label: 'Gold',
    threshold: 25,
    icon: Crown,
    color: '#FCD34D',
    bg: 'rgba(252, 211, 77, 0.12)',
    border: 'rgba(252, 211, 77, 0.3)',
  },
  {
    key: 'silver',
    label: 'Silver',
    threshold: 10,
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

export default function KnowledgeLeaderboard({ workspaceId, refreshKey }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/leaderboard`, {
      signal: controller.signal,
      params: { refresh: Date.now() },
      headers: { 'Cache-Control': 'no-cache' },
    }).then((response) => {
      setError('');
      setUsers(response.data?.leaders ?? []);
    }).catch((failure) => {
      if (failure?.code !== 'ERR_CANCELED') {
        setUsers([]);
        setError(failure?.response?.data?.detail || 'Could not load contributors.');
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId, refreshKey]);

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

      {loading ? (
        <div className="flex items-center gap-2 px-2 py-3 text-[11px]" style={{ color: 'var(--dc-text-muted)' }}>
          <LoaderCircle size={13} className="animate-spin" /> Loading contributors…
        </div>
      ) : error ? (
        <p className="px-2 py-3 text-[11px] leading-4" style={{ color: 'var(--dc-red)' }}>{error}</p>
      ) : sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[11px] leading-4" style={{ color: 'var(--dc-text-muted)', borderColor: 'var(--dc-border)' }}>
          No contributors yet in this workspace
        </p>
      ) : sorted.map((user, idx) => {
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
