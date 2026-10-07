import { loadRuntime } from './runtime/config.mjs';
import { executeCommand, commandHelp } from './app.mjs';
import { parseCommandArguments } from './runtime/arguments.mjs';
try {
  const {options,positionals}=parseCommandArguments(process.argv.slice(2).map(arg=>arg==='-h'?'--help':arg));
  const args=[...positionals];
  for(const [key,value]of Object.entries(options))if(!['config','help'].includes(key)){args.push('--'+key);if(value!==true)args.push(value);}
  const configFile=options.config;
  const help = options.help || args[0] === 'help';
  if (!help && args[0] !== 'doctor' && Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('NODE_24_REQUIRED');
  process.stdout.write(JSON.stringify(help ? commandHelp() : executeCommand(loadRuntime({ configFile, diagnostic:args[0]==='doctor', allowMissingConfig:args[0]==='init' }), args), null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.code ?? 'SGS_ERROR', message: error.message,field:error.field,expected:error.expected,actual:error.actual }) + '\n');
  process.exitCode = 2;
}
