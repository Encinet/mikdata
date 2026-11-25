import { MAX_BUILDING_IMAGE_BYTES, MAX_BUILDING_IMAGE_DIMENSION } from '../../buildings/images/limits';
import { MAX_BUILDING_IMAGES } from '../../buildings/validation';

export const ADMIN_GALLERY = /* html */ `
<section class="gallery" id="gallery" aria-labelledby="gallery-title">
  <div class="gallery-head">
    <div><h3 id="gallery-title" tabindex="-1">建筑图片</h3><span id="gallery-count"></span></div>
    <button class="btn ghost sm" id="gallery-add" type="button">添加图片</button>
    <input id="gallery-files" type="file" accept="image/*" multiple hidden>
  </div>
  <p class="hint" id="gallery-hint">拖动排序，首图为封面。</p>
  <p class="gallery-status" id="gallery-status" role="status"></p>
  <ul class="gallery-errors" id="gallery-errors" aria-live="polite" hidden></ul>
  <ol class="gallery-list" id="gallery-list" aria-label="图片顺序"></ol>
  <div class="gallery-empty" id="gallery-empty">也可以把图片拖到这里。</div>
</section>
`;

export const ADMIN_IMAGE_PREVIEW = /* html */ `
<dialog class="overlay image-preview" id="image-preview" aria-labelledby="image-preview-title">
  <div class="image-preview-panel">
    <div class="gallery-head"><h2 id="image-preview-title"></h2><button type="button" class="btn ghost sm" id="image-preview-close">关闭</button></div>
    <picture><source id="image-preview-jxl" type="image/jxl"><img id="image-preview-img" alt=""></picture>
  </div>
</dialog>
`;

export const ADMIN_GALLERY_SCRIPT = /* js */ `
const gallery = {
  images: [],
  draft: '',
  target: null,
  buildingId: null,
  uploading: false,
  dragged: null,
};
const maxGalleryImages = ${MAX_BUILDING_IMAGES};
const galleryList = $('gallery-list');
const galleryFiles = $('gallery-files');
const imagePreview = $('image-preview');

$('gallery-add').addEventListener('click', () => galleryFiles.click());
galleryFiles.addEventListener('change', () => {
  const files = Array.from(galleryFiles.files);
  galleryFiles.value = '';
  addImages(files);
});
$('image-preview-close').addEventListener('click', () => imagePreview.close());
imagePreview.addEventListener('click', (event) => {
  if (event.target === imagePreview) imagePreview.close();
});
imagePreview.addEventListener('close', () => {
  $('image-preview-jxl').removeAttribute('srcset');
  $('image-preview-img').removeAttribute('src');
});

function resetGallery(images, target = null) {
  gallery.images = images;
  gallery.draft = crypto.randomUUID();
  gallery.target = target;
  gallery.buildingId = target;
  gallery.dragged = null;
  $('gallery-status').textContent = '';
  showGalleryErrors([]);
  renderGallery();
}

function buildingImageUrl(id, hash, format) {
  return imageBaseUrl && id && hash ? imageBaseUrl + '/buildings/' + id + '/' + hash + '.' + format : '';
}

function buildingPicture(id, image, attributes) {
  return '<picture><source type="image/jxl" srcset="' + esc(buildingImageUrl(id, image.jxl, 'jxl')) + '">' +
    '<img ' + attributes + ' src="' + esc(buildingImageUrl(id, image.webp, 'webp')) + '" alt=""></picture>';
}

function fallbackToWebp(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const source = image.closest('picture')?.querySelector('source[type="image/jxl"]');
  if (source && image.currentSrc === source.srcset) source.removeAttribute('srcset');
}

document.addEventListener('error', fallbackToWebp, true);

function renderGallery() {
  const count = gallery.images.length;
  $('gallery-count').textContent = count + ' / ' + maxGalleryImages;
  $('gallery-empty').hidden = count > 0;
  galleryList.innerHTML = gallery.images.map((image, index) => {
    const label = index === 0 ? '封面' : '第 ' + (index + 1) + ' 张';
    const attrs = ' type="button" data-index="' + index + '"';
    return '<li class="gallery-tile" data-index="' + index + '" draggable="true">' +
      '<button class="gallery-preview"' + attrs + ' data-gallery="preview" aria-label="预览' + label + '">' +
      buildingPicture(gallery.buildingId, image, 'draggable="false" loading="lazy" decoding="async"') +
      (index === 0 ? '<span>封面</span>' : '') + '</button>' +
      '<div class="gallery-actions">' +
      '<button class="btn ghost sm"' + attrs + ' data-gallery="earlier" aria-label="前移' + label + '"' +
      (index === 0 ? ' disabled' : '') + '>←</button>' +
      '<button class="btn ghost sm"' + attrs + ' data-gallery="later" aria-label="后移' + label + '"' +
      (index === count - 1 ? ' disabled' : '') + '>→</button>' +
      '<button class="btn danger sm"' + attrs + ' data-gallery="remove" aria-label="移除' + label + '">移除</button>' +
      '</div></li>';
  }).join('');
  updateGalleryControls();
}

function updateGalleryControls() {
  const locked = state.busy || gallery.uploading;
  $('gallery-add').disabled = locked || gallery.images.length >= maxGalleryImages;
  galleryList.inert = locked;
}

function moveImage(from, to, focusAction) {
  if (from === to || to < 0 || to >= gallery.images.length) return;
  gallery.images.splice(to, 0, gallery.images.splice(from, 1)[0]);
  renderGallery();
  $('gallery-status').textContent = '已将图片移至第 ' + (to + 1) + ' 张。';
  if (focusAction) focusGalleryButton(to, focusAction);
}

function focusGalleryButton(index, action) {
  const tile = galleryList.children[index];
  (tile?.querySelector('[data-gallery="' + action + '"]:enabled') ||
    tile?.querySelector('.gallery-preview') || $('gallery-add')).focus();
}

galleryList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-gallery]');
  if (!button || state.busy || gallery.uploading) return;
  const index = Number(button.dataset.index);
  const action = button.dataset.gallery;
  if (action === 'preview') {
    const title = index === 0 ? '封面预览' : '第 ' + (index + 1) + ' 张图片';
    $('image-preview-title').textContent = title;
    $('image-preview-img').alt = title;
    $('image-preview-jxl').srcset = buildingImageUrl(gallery.buildingId, gallery.images[index].jxl, 'jxl');
    $('image-preview-img').src = buildingImageUrl(gallery.buildingId, gallery.images[index].webp, 'webp');
    imagePreview.showModal();
  } else if (action === 'remove') {
    gallery.images.splice(index, 1);
    renderGallery();
    $('gallery-status').textContent = '已从图册移除图片，保存后生效。';
    focusGalleryButton(Math.min(index, gallery.images.length - 1), 'remove');
  } else {
    moveImage(index, index + (action === 'earlier' ? -1 : 1), action);
  }
});

galleryList.addEventListener('dragstart', (event) => {
  const tile = event.target.closest('.gallery-tile');
  if (!tile || state.busy || gallery.uploading) {
    event.preventDefault();
    return;
  }
  gallery.dragged = Number(tile.dataset.index);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tile.dataset.index);
  tile.classList.add('dragging');
});
galleryList.addEventListener('dragend', clearGalleryDrag);

function clearGalleryDrag() {
  gallery.dragged = null;
  galleryList.querySelectorAll('.dragging, .drop-target').forEach((tile) => {
    tile.classList.remove('dragging', 'drop-target');
  });
}

const galleryArea = $('gallery');
galleryArea.addEventListener('dragover', (event) => {
  if (state.busy || gallery.uploading) return;
  const files = event.dataTransfer.types.includes('Files');
  if (gallery.dragged === null && !files) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = files ? 'copy' : 'move';
  galleryArea.classList.toggle('file-target', files);
  const target = files ? null : event.target.closest('.gallery-tile');
  galleryList.querySelectorAll('.gallery-tile').forEach((tile) => {
    tile.classList.toggle('drop-target', tile === target && Number(tile.dataset.index) !== gallery.dragged);
  });
});
galleryArea.addEventListener('dragleave', (event) => {
  if (galleryArea.contains(event.relatedTarget)) return;
  galleryArea.classList.remove('file-target');
  galleryList.querySelector('.drop-target')?.classList.remove('drop-target');
});
galleryArea.addEventListener('drop', (event) => {
  event.preventDefault();
  galleryArea.classList.remove('file-target');
  if (!state.busy && !gallery.uploading) {
    const files = Array.from(event.dataTransfer.files);
    const tile = event.target.closest('.gallery-tile');
    if (files.length) addImages(files);
    else if (gallery.dragged !== null && tile) moveImage(gallery.dragged, Number(tile.dataset.index));
  }
  clearGalleryDrag();
});
$('overlay').addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
$('overlay').addEventListener('drop', (event) => {
  if (event.dataTransfer.files.length) event.preventDefault();
});

async function addImages(files) {
  if (!files.length || state.busy || gallery.uploading) return;
  const errors = [];
  gallery.uploading = true;
  updateEditorControls();
  showGalleryErrors([]);
  let added = 0;
  let worker;
  try {
    for (const [index, file] of files.entries()) {
      if (gallery.images.length >= maxGalleryImages) {
        errors.push('最多保留 ' + maxGalleryImages + ' 张图片，剩余 ' + (files.length - index) + ' 张未上传。');
        break;
      }
      const progress = (index + 1) + ' / ' + files.length + ' · ' + file.name;
      $('gallery-status').textContent = '正在转换 ' + progress;
      try {
        worker ??= new Worker('/building-codec/encode-building-image.js', { type: 'module' });
        const body = await encodeGalleryImage(file, worker);
        $('gallery-status').textContent = '正在上传 ' + progress;
        const target = gallery.target ? '?building=' + encodeURIComponent(gallery.target) : '';
        const response = await fetch('/admin/api/building-images' + target, {
          method: 'POST',
          headers: { 'X-Building-Draft': gallery.draft },
          body,
        });
        const data = await readJson(response);
        if (!response.ok || !data.image?.webp || !data.image?.jxl || !data.buildingId)
          throw new Error(imageUploadError(data.error));
        if (gallery.images.some(image => image.webp === data.image.webp && image.jxl === data.image.jxl)) {
          errors.push(file.name + ' · 图片已在图册中');
          continue;
        }
        gallery.buildingId = data.buildingId;
        gallery.images.push(data.image);
        added++;
        renderGallery();
      } catch (error) {
        worker?.terminate();
        worker = undefined;
        errors.push(file.name + ' · ' + (error.message || '上传失败'));
      }
    }
  } finally {
    worker?.terminate();
    gallery.uploading = false;
    updateEditorControls();
    $('gallery-status').textContent = added ? '已添加 ' + added + ' 张图片。' : '';
    showGalleryErrors(errors);
  }
}

async function encodeGalleryImage(file, worker) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取此图片格式');
  }
  const scale = Math.min(1, ${MAX_BUILDING_IMAGE_DIMENSION} / Math.max(bitmap.width, bitmap.height));
  const tryLossless = file.type === 'image/png' && file.size <= bitmap.width * bitmap.height;
  let context;
  try {
    context = drawGalleryImage(bitmap, bitmap.width * scale, bitmap.height * scale);
  } finally {
    bitmap.close();
  }
  try {
    while (true) {
      const { canvas } = context;
      const { webp, jxl } = await encodeGalleryPixels(worker, context, tryLossless);
      const size = webp.byteLength + jxl.byteLength;
      if (size <= ${MAX_BUILDING_IMAGE_BYTES}) {
        const form = new FormData();
        form.set('webp', new Blob([webp], { type: 'image/webp' }), 'building.webp');
        form.set('jxl', new Blob([jxl], { type: 'image/jxl' }), 'building.jxl');
        return form;
      }

      const scale = 0.95 * Math.sqrt(${MAX_BUILDING_IMAGE_BYTES} / size);
      const width = Math.max(1, Math.round(canvas.width * scale));
      const height = Math.max(1, Math.round(canvas.height * scale));
      if (width === canvas.width && height === canvas.height)
        throw new Error('WebP 和 JPEG XL 合计超过 4 MiB');
      context = drawGalleryImage(canvas, width, height);
      canvas.width = 0;
    }
  } finally {
    context.canvas.width = 0;
  }
}

function drawGalleryImage(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理图片');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return context;
}

function encodeGalleryPixels(worker, context, tryLossless) {
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('无法生成 WebP 或 JPEG XL'));
    worker.addEventListener('error', failed, options);
    worker.addEventListener('messageerror', failed, options);
    worker.addEventListener('message', ({ data }) => data ? resolve(data) : failed(), options);
    worker.postMessage({ pixels, tryLossless }, [pixels.data.buffer]);
  }).finally(() => listeners.abort());
}

function showGalleryErrors(errors) {
  $('gallery-errors').hidden = !errors.length;
  $('gallery-errors').replaceChildren(...errors.map((error) => {
    const item = document.createElement('li');
    item.textContent = error;
    return item;
  }));
}

function imageUploadError(code) {
  return {
    image_upload_not_configured: '图片存储尚未配置',
    image_too_large: 'WebP 和 JPEG XL 合计超过 4 MiB',
    invalid_image: '图片内容无效',
    image_draft_unavailable: '草稿已失效，请重新打开编辑窗口',
    image_unavailable: '图片暂不可用，请稍后重试',
  }[code] || '上传失败，请重试';
}
`;
