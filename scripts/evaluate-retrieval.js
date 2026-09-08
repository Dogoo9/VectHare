import fs from 'node:fs';
import { evaluateRetrieval } from '../core/retrieval-evaluation.js';

const input = process.argv[2] || new URL('../evaluation/retrieval-datasets.json', import.meta.url);
const datasets = JSON.parse(fs.readFileSync(input, 'utf8'));
const report = evaluateRetrieval(datasets);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
