import path from 'node:path';
import { parseOptions } from '../src/runtime/arguments.mjs';
import { projectRoot } from '../src/runtime/config.mjs';
import { renderEntry } from '../src/deployment.mjs';
const {options,positionals}=parseOptions(process.argv.slice(2),{values:['project','out','node','config']});
if(positionals.length)throw new Error('UNEXPECTED_ARGUMENT');
if(!options.out)throw new Error('--out is required; no automatic installation into discovery roots');
console.log(JSON.stringify(renderEntry({project:path.resolve(options.project??projectRoot),out:path.resolve(options.out),node:options.node,config:options.config,templateProject:projectRoot})));
