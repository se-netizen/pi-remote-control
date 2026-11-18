import { THINKING_LEVELS, type AvailableModel, type ModelProfile, type ModelProfiles, type ResolvedModel, type ThinkingLevel, type WorkflowTask } from './types.js';
import { WorkflowValidationError } from './policy.js';

const rank = (level: ThinkingLevel) => THINKING_LEVELS.indexOf(level);
/** Select the nearest supported level at or below the desired effort, otherwise the lowest supported. */
export function chooseThinkingLevel(desired: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
  if (!supported.length || supported.some(level => !THINKING_LEVELS.includes(level))) throw new WorkflowValidationError('Model returned invalid thinking capabilities');
  const ordered = [...new Set(supported)].sort((a, b) => rank(a) - rank(b));
  return ordered.filter(level => rank(level) <= rank(desired)).at(-1) ?? ordered[0]!;
}
export function resolveModel(task: Pick<WorkflowTask, 'role' | 'complexity'>, profiles: ModelProfiles = {}, models?: AvailableModel[]): ResolvedModel {
  const role = task.role ?? 'worker', complexity = task.complexity ?? 'standard';
  const profile: ModelProfile = { ...profiles[role], ...(role === 'worker' ? profiles.complexity?.[complexity] : {}) };
  if ((profile.provider === undefined) !== (profile.model === undefined) || (profile.provider !== undefined && (!profile.provider.trim() || !profile.model?.trim()))) throw new WorkflowValidationError('Model profiles require provider and model together');
  if (profile.thinkingLevel !== undefined && !['auto', 'inherit', ...THINKING_LEVELS].includes(profile.thinkingLevel)) throw new WorkflowValidationError(`Unknown thinking level: ${profile.thinkingLevel}`);
  const desiredThinkingLevel: ThinkingLevel = role === 'planner' || role === 'reviewer' || complexity === 'complex' ? 'high' : complexity === 'simple' ? 'low' : 'medium';
  const source = profile.thinkingLevel === 'inherit' ? 'inherit' : profile.thinkingLevel === undefined || profile.thinkingLevel === 'auto' ? 'auto' : 'explicit';
  const result: ResolvedModel = { ...profile, desiredThinkingLevel, thinkingSource: source };
  if (source === 'inherit') { delete result.thinkingLevel; return result; }
  const available = profile.provider && profile.model ? models?.find(m => m.provider === profile.provider && m.id === profile.model) : undefined;
  if (models && profile.model && !available) throw new WorkflowValidationError(`Configured model unavailable: ${profile.provider}/${profile.model}`);
  const supported = available?.thinkingLevels ?? (available?.reasoning === false ? ['off'] as ThinkingLevel[] : undefined);
  if (source === 'explicit') {
    if (supported && !supported.includes(profile.thinkingLevel as ThinkingLevel)) throw new WorkflowValidationError(`Thinking level ${profile.thinkingLevel} unsupported by ${profile.provider}/${profile.model}`);
  } else {
    result.thinkingLevel = supported ? chooseThinkingLevel(desiredThinkingLevel, supported) : 'auto';
  }
  return result;
}
