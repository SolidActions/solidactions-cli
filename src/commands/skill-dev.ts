/**
 * solidactions skill dev <dir> -- <command...>
 *
 * Runs YOUR WORKING COPY (the folder you're editing) locally, with crew
 * variables fetched at runtime. Counterpart of `skill exec`, which always
 * executes the SERVER-STORED skill (--target sandbox|host). Renamed from
 * `skill run` (deprecated alias kept until v2.0.0): "run" collides with the
 * workflow-runs noun (`solidactions run …`), and run-vs-exec didn't encode
 * the source-of-truth split agents need.
 */
export { skillRun as skillDev, SkillRunOptions as SkillDevOptions } from './skill-run';
