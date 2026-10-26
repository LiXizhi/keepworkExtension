const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
/** Only native main processes can read bridge credentials; renderer sees no token. */
function connectPermissionPet(pet, { role = 'desktop', retire = () => {}, home = process.env.KEEPWORK_PET_HOME || path.join(os.homedir(), '.keepwork-mcp') } = {}) {
  let socket, stopped = false, activeId;
  const reconnect = () => {
    if (stopped || socket) return;
    let record; try { record = JSON.parse(fs.readFileSync(path.join(home, 'pet-permission-bridge.json'), 'utf8')); } catch { return; }
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !/^[a-f0-9]{64}$/.test(record.token)) return;
    const connection = net.createConnection({ host: '127.0.0.1', port: record.port }); socket = connection;
    let buffer = '';
    connection.on('connect', () => connection.write(JSON.stringify({ token: record.token, role }) + '\n'));
    connection.on('error', () => connection.destroy());
    connection.on('close', () => { if (socket === connection) socket = undefined; pet.cancelPermission(activeId); activeId = undefined; if (role === 'companion') retire(); });
    connection.on('data', data => {
      buffer += data.toString(); if (buffer.length > 8192) { connection.destroy(); return; }
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
        let message; try { message = JSON.parse(line); } catch { connection.destroy(); return; }
        if (message.type === 'retire') { if (role === 'companion') retire(); connection.destroy(); return; }
        if (message.type === 'restore') pet.restorePermission?.();
        if (message.type === 'cancel') { pet.cancelPermission(message.id); activeId = undefined; }
        if (message.type === 'permission' && typeof message.id === 'string' && typeof message.client === 'string') {
          activeId = message.id;
          pet.requestPermission(message).then(choice => {
            if (socket === connection && activeId === message.id) { activeId = undefined; connection.write(JSON.stringify({ type: 'choice', id: message.id, choice }) + '\n'); }
          }, () => {
            if (socket === connection && activeId === message.id) { activeId = undefined; connection.write(JSON.stringify({ type: 'choice', id: message.id, choice: 'cancel' }) + '\n'); }
          });
        }
      }
    });
  };
  const timer = setInterval(reconnect, 1000); timer.unref?.(); reconnect();
  return () => { stopped = true; clearInterval(timer); pet.cancelPermission(activeId); socket?.destroy(); };
}
module.exports = { connectPermissionPet };
