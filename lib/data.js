import { getSupabase } from './supabase.js';
import { mapDbError, turnout } from './utils.js';

function raiseIf(error) {
    if (error) throw mapDbError(error);
}

export async function getSettings() {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('settings')
        .select('is_voting_open, allow_public_results, allow_self_registration, updated_at')
        .eq('id', 1)
        .single();

    raiseIf(error);

    return {
        isVotingOpen: Boolean(data.is_voting_open),
        allowPublicResults: Boolean(data.allow_public_results),
        allowSelfRegistration: Boolean(data.allow_self_registration),
        updatedAt: data.updated_at
    };
}

export async function getStats() {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('election_stats')
        .select('total_voters, voted_voters, total_votes, total_candidates')
        .single();

    raiseIf(error);

    const totalVoters = Number(data.total_voters) || 0;
    const totalVotes = Number(data.total_votes) || 0;
    const totalCandidates = Number(data.total_candidates) || 0;

    return {
        totalVoters,
        votedVoters: Number(data.voted_voters) || 0,
        totalVotes,
        totalCandidates,
        turnout: turnout(totalVotes, totalVoters)
    };
}

function mapCandidate(candidate, votes = 0) {
    const missions = Array.isArray(candidate.candidate_missions) ? candidate.candidate_missions : [];
    return {
        id: candidate.id,
        number: candidate.number,
        name: candidate.name,
        photo: candidate.photo_url || '',
        vision: candidate.vision || '',
        mission: missions
            .slice()
            .sort((a, b) => a.position - b.position)
            .map(item => item.text),
        votes: Number(votes) || 0
    };
}

async function getVoteMap() {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('candidate_results')
        .select('candidate_id, votes');

    raiseIf(error);

    const map = new Map();
    (data || []).forEach(row => map.set(row.candidate_id, Number(row.votes) || 0));
    return map;
}

export async function getCandidates({ withVotes = false } = {}) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('candidates')
        .select('id, number, name, photo_url, vision, candidate_missions(position, text)')
        .order('number', { ascending: true });

    raiseIf(error);

    const voteMap = withVotes ? await getVoteMap() : null;

    return (data || []).map(candidate =>
        mapCandidate(candidate, voteMap ? voteMap.get(candidate.id) || 0 : 0)
    );
}

export function mapVoter(voter) {
    return {
        id: voter.id,
        name: voter.name,
        className: voter.class_name || '',
        nit: voter.nit || '',
        votedAt: voter.voted_at || null,
        createdAt: voter.created_at || null
    };
}

export async function getVoters() {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('voters')
        .select('id, name, class_name, nit, voted_at, created_at')
        .order('class_name', { ascending: true })
        .order('name', { ascending: true });

    raiseIf(error);
    return (data || []).map(mapVoter);
}

export async function getTopVoters(limit = 4) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('voters')
        .select('name, class_name, voted_at')
        .not('voted_at', 'is', null)
        .order('voted_at', { ascending: true })
        .limit(limit);

    raiseIf(error);
    return (data || []).map(voter => ({
        name: voter.name,
        className: voter.class_name || '',
        votedAt: voter.voted_at
    }));
}

export async function resolveVoter({ name, className, nit }) {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('resolve_voter', {
        p_name: name,
        p_class: className,
        p_nit: nit
    });

    raiseIf(error);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw mapDbError(new Error('VOTER_NOT_FOUND'));

    return {
        voter: mapVoter(row),
        isNew: Boolean(row.is_new)
    };
}

export async function importVoters(rows) {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('import_voters', { p_rows: rows });

    raiseIf(error);

    return {
        added: Number(data?.added) || 0,
        updated: Number(data?.updated) || 0,
        skipped: Number(data?.skipped) || 0,
        invalid: Number(data?.invalid) || 0,
        errors: Array.isArray(data?.errors) ? data.errors : []
    };
}

export async function getVoterById(id) {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('voters')
        .select('id, name, class_name, nit, voted_at, created_at')
        .eq('id', id)
        .maybeSingle();

    raiseIf(error);
    return data ? mapVoter(data) : null;
}
