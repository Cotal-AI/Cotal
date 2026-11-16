/** Read only the latest owned npm debug log, filtering authentication lines before returning bytes. */
export async function npmDebugTail(root) {
  const fs=await import('node:fs');
  const path=await import('node:path');
  const directory=path.join(root,'cache','_logs');
  for(const entry of [root,path.join(root,'cache'),directory]){
    const stat=fs.lstatSync(entry);
    if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||fs.realpathSync(entry)!==entry)throw Error('unsafe npm diagnostic directory');
  }
  const names=fs.readdirSync(directory).filter(name=>/^[0-9T_Z.:-]+-debug-[0-9]+\.log$/.test(name)).sort();
  if(!names.length)throw Error('npm debug log missing');
  const name=names.at(-1),file=path.join(directory,name);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1)throw Error('unsafe npm diagnostic file');
    const size=Math.min(stat.size,1024*1024),buffer=Buffer.alloc(size);
    const count=fs.readSync(fd,buffer,0,size,stat.size-size);
    let lines=buffer.subarray(0,count).toString('utf8').split(/\r?\n/);
    if(stat.size>size)lines.shift();
    if(lines.at(-1)==='')lines.pop();
    lines=lines.slice(-200).map(line=>/token|authorization|_auth|password|passwd|credential|bearer\s|https?:\/\/[^\s/]+@|registry.*(?:auth|secret)/i.test(line)?'<authentication line filtered>':line.slice(0,1024));
    return {name,sourceBytes:stat.size,tailTruncated:stat.size>size,lines:lines.length,text:lines.join('\n')+'\n'};
  }finally{fs.closeSync(fd);}
}
