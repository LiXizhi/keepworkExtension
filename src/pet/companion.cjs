const electron = require('electron');
const { app } = electron;
const { createPetWindow } = require('./petWindow.cjs');
const { connectPermissionPet } = require('./permissionClient.cjs');
let pet, disconnect;
app.setName('Keepwork Permission Pet');
app.whenReady().then(() => {
  app.dock?.hide();
  pet = createPetWindow(electron, __dirname, {
    position: () => null, savePosition() {}, preferences: () => ({ appearance: 'dragon', scale: 1 }),
    open() {}, command() { throw Error('This pet handles screenshot permission only'); }, quit: () => app.quit(), hide: () => pet.hide(),
  });
  disconnect = connectPermissionPet(pet, { role: 'companion', retire: () => app.quit() });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { disconnect?.(); pet?.dispose(); });
