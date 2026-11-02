import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { RunScope } from '../skills/burn-down-github-issues/lib/run-scope.ts';
const facts = [
 {number:12,parent:{number:11}}, {number:11,parent:{number:10}},
 {number:10}, {number:21,parent:{number:20}}, {number:20}, {number:22,parent:{number:20}},
];
function* permutations<T>(xs:T[]): Generator<T[]> {
 if (!xs.length) { yield []; return; }
 for(let i=0;i<xs.length;i++) for(const rest of permutations(xs.filter((_,j)=>j!==i))) yield [xs[i],...rest];
}
const source = readFileSync('skills/burn-down-github-issues/loop.ts','utf8');
const predicate = source.match(/findStranded\(ctx, allIssues\(\)\.filter\((.*?)\), CONFIG.skipLabels\)/)?.[1];
assert.ok(predicate);
let checked=0;
for(const ordered of permutations(facts)) {
 const scope = new RunScope([10,21]);
 assert.deepEqual(scope.refresh(ordered).sort((a,b)=>a-b), [11,12]);
 const filter = new Function('ONLY', `return (${predicate});`)(scope.effective);
 assert.deepEqual(ordered.filter(filter).map(x=>x.number).sort((a,b)=>a-b),[10,11,12,21]);
 assert.deepEqual(scope.refresh(ordered),[]);
 assert.deepEqual(scope.refresh([...ordered,{number:13,parent:{number:12}}]),[13]);
 checked++;
}
console.log(JSON.stringify({permutations:checked, roots:[10,21], effective:[10,11,12,21], excluded:[20,22], repeatedRefresh:[], addedDescendant:[13], resumptionPredicate:predicate, result:'PASS'},null,2));
