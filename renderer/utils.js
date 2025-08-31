export function setGridSize(gridEl, size) {
  gridEl.classList.remove('small', 'medium', 'large');
  gridEl.classList.add(size);
}

export function makeTile({ filename, imagePath }, clickHandler) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  const img = document.createElement('img');
  img.src = `file://${imagePath}`;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = filename;
  tile.appendChild(img);
  tile.appendChild(name);
  tile.addEventListener('click', (e) => clickHandler(e, tile));
  return tile;
}
