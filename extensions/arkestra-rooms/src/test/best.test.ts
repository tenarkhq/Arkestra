/*---------------------------------------------------------------------------------------------
 *  Arkestra. Best-of-N: tries per agent, the attempt plan, work trees from one base, commits
 *  and measures, the comparison, landing the chosen attempt and removing the rest.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { attemptDiff, attemptFiles, attemptPrompt, cleanupRun, collectAttempt, comparePrompt, comparisonTable, createAttempts, parseBest, planAttempts, runAttemptTests, type BestRun } from '../best';
import { landBranch } from '../templates/gitio';

test('tries per agent: a leading number or x3; two tries when one agent is alone', () => {
	assert.deepEqual(parseBest('2 add validation', 3), { perAgent: 2, task: 'add validation' });
	assert.deepEqual(parseBest('x3 add validation', 1), { perAgent: 3, task: 'add validation' });
	assert.deepEqual(parseBest('add validation', 1), { perAgent: 2, task: 'add validation' });
	assert.deepEqual(parseBest('add validation', 2), { perAgent: 1, task: 'add validation' });
	assert.deepEqual(parseBest('2024 bug in the date parser', 2), { perAgent: 1, task: '2024 bug in the date parser' }, 'a number that is part of the task is not a count');
});

test('the plan goes round by round, so the limit keeps every agent in', () => {
	const agents = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }];
	assert.deepEqual(planAttempts(agents, 1).map(a => a.agentName), ['Claude', 'Codex']);
	assert.deepEqual(planAttempts(agents, 4).map(a => a.agentName), ['Claude #1', 'Codex #1', 'Claude #2', 'Codex #2', 'Claude #3', 'Codex #3']);
});

test('git: attempts from one base, committed and measured, compared; the chosen one lands, the rest are removed', async () => {
	const repo = await mkdtemp(path.join(tmpdir(), 'arkestra-best-'));
	const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
	sh(repo, 'init', '-q', '-b', 'main');
	await writeFile(path.join(repo, 'app.js'), 'const a = 1;\n');
	sh(repo, 'add', '.');
	sh(repo, 'commit', '-q', '-m', 'init');

	const plan = planAttempts([{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }], 1);
	const { baseHead, attempts } = await createAttempts(repo, 'main', 'r1', plan);
	assert.equal(attempts.length, 2);
	assert.equal(sh(repo, 'status', '--porcelain'), '', 'the work trees stay out of the project');
	assert.match(attemptPrompt('validáció', attempts[0], 2), /A munkafád: .*1-claude \(git ág: arkestra\/best-r1-1-claude\)/);

	await writeFile(path.join(attempts[0].dir, 'app.js'), 'const a = 2;\nconst b = 3;\n');
	await writeFile(path.join(attempts[0].dir, 'test.js'), 'ok\n');
	await writeFile(path.join(attempts[1].dir, 'app.js'), 'let a = 1;\n');
	for (const a of attempts) {
		await collectAttempt(a, baseHead, `${a.agentName}: validáció`);
		a.state = 'done';
	}
	assert.deepEqual([attempts[0].files, attempts[0].added, attempts[0].removed], [2, 3, 1]);
	assert.deepEqual([attempts[1].files, attempts[1].added, attempts[1].removed], [1, 1, 1]);
	assert.deepEqual(await attemptFiles(attempts[0], baseHead), [{ status: 'M', path: 'app.js' }, { status: 'A', path: 'test.js' }]);
	assert.match(await attemptDiff(attempts[1], baseHead), /-const a = 1;\n\+let a = 1;/);
	assert.equal((await runAttemptTests(attempts[0].dir, 'test -f test.js')).ok, true);
	assert.equal((await runAttemptTests(attempts[1].dir, 'test -f test.js')).ok, false);

	const run: BestRun = { id: 'r1', task: 'validáció', repo, base: 'main', baseHead, attempts, state: 'done', test: 'npm test' };
	attempts[0].tests = { ok: true };
	attempts[0].summary = 'Két | sor';
	const table = comparisonTable(run);
	assert.match(table, /\| 1 \| Claude \| 2 fájl · \+3 −1 \| ✓ \| Két \\\| sor \|/);
	assert.match(table, /\| 2 \| Codex \| 1 fájl · \+1 −1 \| – \|/);
	assert.match(comparePrompt(run, ['d1', 'd2']), /### 1\. próba · Claude · teszt: zöld[\s\S]*```diff\nd1\n```[\s\S]*melyiket választanátok/);

	const landed = await landBranch(repo, 'main', attempts[0].branch, 'Claude: validáció');
	assert.equal(landed.ok && landed.how, 'fast-forward');
	await cleanupRun(run);
	assert.equal(await readFile(path.join(repo, 'test.js'), 'utf8'), 'ok\n', 'the chosen attempt is in main');
	await assert.rejects(stat(attempts[1].dir), 'the work trees are gone');
	assert.equal(sh(repo, 'branch', '--list', 'arkestra/*'), '', 'and their branches');
});
