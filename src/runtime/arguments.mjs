const fail=(code)=>{throw Object.assign(new Error(code),{code});};
export function parseOptions(args, { values=[], flags=[] }={}) {
  const options={},positionals=[];
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(!arg.startsWith('--')){positionals.push(arg);continue;}
    const split=arg.indexOf('='); const key=split<0?arg.slice(2):arg.slice(2,split);
    if(!(values.includes(key)||flags.includes(key)))fail('UNKNOWN_OPTION: '+key);
    if(Object.hasOwn(options,key))fail(key==='config'?'DUPLICATE_CONFIG_OPTION':'DUPLICATE_OPTION: '+key);
    if(flags.includes(key)){if(split>=0)fail('FLAG_VALUE_NOT_ALLOWED: '+key);options[key]=true;continue;}
    const value=split<0?args[++i]:arg.slice(split+1);
    if(!value||value.startsWith('-'))fail(key==='batch'?'BATCH_ID_REQUIRED':key.toUpperCase().replaceAll('-','_')+'_VALUE_REQUIRED');
    options[key]=value;
  }
  return {options,positionals};
}
export function parseCommandArguments(args) {
  const result=parseOptions(args,{values:['config','batch','authorization','max-items','evidence','checks','root','entry','project','node'],flags:['safe','apply','verify','rollback','authorized','help']});
  const commands=['safe','apply','verify','rollback'].filter(key=>result.options[key]);
  if(commands.length>1)fail('CONFLICTING_CLEANUP_OPERATION');
  return result;
}
