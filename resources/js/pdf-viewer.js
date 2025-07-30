import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.3.31/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.3.31/pdf.worker.min.mjs';

const pageMarginBottom = parseInt(
  getComputedStyle(document.documentElement).getPropertyValue('--pdf-page-margin-bottom')
) || 0;

function yieldToMain() {
  if (globalThis.scheduler?.yield) {
    return scheduler.yield();
  }
  if (typeof queueMicrotask === 'function') {
    return new Promise(queueMicrotask);
  }
  // Fallback for older browsers
  return new Promise(resolve => setTimeout(resolve, 0));
}

const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');
const SAFARI_BATCH_SIZE = isSafari ? 1 : 3;
const FIREFOX_BATCH_SIZE = isFirefox ? 2 : 3;
const BATCH_SIZE = isSafari ? SAFARI_BATCH_SIZE : (isFirefox ? FIREFOX_BATCH_SIZE : 3);

async function runTasksBatched(tasks) {
  let processed = 0;
  const startTime = performance.now();
  
  for (const task of tasks) {
    const taskStart = performance.now();
    
    try {
      await task();
    } catch (error) {
      // [DEBUGGING CODE]
      // console.warn('Task failed:', error);
      continue;
    }
    
    processed++;
    const taskDuration = performance.now() - taskStart;
    
    if (processed >= BATCH_SIZE || taskDuration > 5 || performance.now() - startTime > 16) {
      await yieldToMain();
      processed = 0;
    }
  }
}

function getZoomText(value) {
    const zoomTexts = {
        'auto': 'Automatic Zoom',
        'fit': 'Page Fit',
        'width': 'Page Width',
        '0.25': '25%',
        '0.5': '50%',
        '0.75': '75%',
        '1': '100%',
        '1.25': '125%',
        '1.5': '150%',
        '1.75': '175%',
        '2': '200%',
        '2.25': '225%',
        '2.5': '250%',
        '2.75': '275%',
        '3': '300%'
    };
    return zoomTexts[value] || 'Automatic Zoom';
}

class VirtualPageManager {
  constructor(pagesContainer, canvasContainer) {
    this.pagesContainer = pagesContainer;
    this.canvasContainer = canvasContainer;
    this.pages = new Map();
    this.visiblePages = new Set();
    this.renderQueue = new Set();
    this.observer = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    this.observer = new IntersectionObserver(
      entries => this.handleIntersections(entries),
      {
        root: this.canvasContainer,
        rootMargin: '200px 0px',
        threshold: 0.01
      }
    );
    
    this.initialized = true;
  }

  async handleIntersections(entries) {
    const renderTasks = [];
    
    for (const entry of entries) {
      const pageNum = parseInt(entry.target.dataset.page, 10);
      
      if (entry.isIntersecting) {
        this.visiblePages.add(pageNum);
        if (!this.renderQueue.has(pageNum)) {
          this.renderQueue.add(pageNum);
          renderTasks.push(() => this.renderPage(pageNum));
        }
      } else {
        this.visiblePages.delete(pageNum);
        this.renderQueue.delete(pageNum);
        this.schedulePageUnload(pageNum);
      }
    }
    
    if (renderTasks.length > 0) {
      await runTasksBatched(renderTasks);
    }
  }

  async renderPage(pageNum) {
    const pageData = this.pages.get(pageNum);
    if (!pageData || pageData.rendered) return;

    try {
      const page = await pageData.pdfPage;
      const canvas = pageData.canvas;
      
      if (!this.renderQueue.has(pageNum)) return;
      
      const ctx = canvas.getContext('2d', { 
        alpha: false,
        desynchronized: true
      });
      
      await page.render({
        canvasContext: ctx,
        viewport: pageData.viewport
      }).promise;
      
      pageData.rendered = true;
    } catch (error) {
      // [DEBUGGING CODE]
      // console.warn(`Failed to render page ${pageNum}:`, error);
    } finally {
      this.renderQueue.delete(pageNum);
    }
  }

  schedulePageUnload(pageNum) {
    setTimeout(() => {
      if (!this.visiblePages.has(pageNum)) {
        this.unloadPage(pageNum);
      }
    }, 2000);
  }

  unloadPage(pageNum) {
    const pageData = this.pages.get(pageNum);
    if (!pageData || this.visiblePages.has(pageNum)) return;
    
    const canvas = pageData.canvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pageData.rendered = false;
  }

  addPage(pageNum, canvas, pdfPage, viewport) {
    this.pages.set(pageNum, {
      canvas,
      pdfPage,
      viewport,
      rendered: false
    });
    this.observer.observe(canvas);
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
    this.pages.clear();
    this.visiblePages.clear();
    this.renderQueue.clear();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const viewer = document.getElementById('pdf-viewer');
  if (!viewer) return;
  
  const pagesContainer = document.getElementById('pdf-pages');
  const canvasContainer = document.getElementById('pdf-canvas-container');
  const url = viewer.dataset.pdf;
  
  const getDecodedFilename = (url) => {
    try {
      const filename = url.split('/').pop();
      let decodedFilename = decodeURIComponent(filename.replace(/\+/g, ' '));
      decodedFilename = decodedFilename.replace(/"/g, "'");
      return decodedFilename;
    } catch (e) {
      // [DEBUGGING CODE]
      // console.warn('Failed to decode filename:', e);
      return url.split('/').pop();
    }
  };

  let pdfDoc = null;
  let pageNum = 1;
  let zoom = 1;
  let currentZoom = 1;
  let zoomMode = 'custom';
  let oldZoom = zoom;
  let oldScrollLeft = 0;
  let oldScrollTop = 0;

  const virtualPageManager = new VirtualPageManager(pagesContainer, canvasContainer);
  await virtualPageManager.initialize();

  const pageNumInput = document.getElementById('pdf-page-num');
  const pageCountSpan = document.getElementById('pdf-page-count');
  const prevBtn = document.getElementById('pdf-prev');
  const nextBtn = document.getElementById('pdf-next');
  const zoomInBtn = document.getElementById('pdf-zoom-in');
  const zoomOutBtn = document.getElementById('pdf-zoom-out');
  const zoomSelect = document.getElementById('pdf-zoom-select');
  const downloadBtn = document.getElementById('pdf-download');
  const printBtn = document.getElementById('pdf-print');
  const sidebar = document.getElementById('pdf-sidebar');
  const sidebarToggle = document.getElementById('pdf-sidebar-toggle');
  const expandBtn = document.getElementById('pdf-expand');
  const frame = document.getElementById('frame');
  let modal = null;
  const frameParent = frame.parentElement;
  const frameNextSibling = frame.nextElementSibling;

  function initCustomZoomDropdown() {
      const container = document.querySelector('.custom-zoom-dropdown');
      const trigger = container.querySelector('.dropdown-trigger');
      const selectedValue = container.querySelector('.selected-value');
      const dropdownOptions = container.querySelector('.dropdown-options');
      const options = dropdownOptions.querySelectorAll('li');
      
      selectedValue.textContent = getZoomText(zoomSelect.value);
      
      trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdownOptions.classList.toggle('show');
      });
      
      options.forEach(option => {
          option.addEventListener('click', () => {
              const value = option.dataset.value;
              zoomSelect.value = value;
              selectedValue.textContent = getZoomText(value);
              dropdownOptions.classList.remove('show');

              option.classList.add('selected');
              options.forEach(opt => {
                  if (opt !== option) {
                      opt.classList.remove('selected');
                  }
              });
              
              zoomSelect.dispatchEvent(new Event('change'));
          });
      });
      
      document.addEventListener('click', (e) => {
          if (!container.contains(e.target)) {
              dropdownOptions.classList.remove('show');
          }
      });
      
      return {
          update: () => {
              selectedValue.textContent = getZoomText(zoomSelect.value);

              options.forEach(opt => {
                  if (opt.dataset.value === zoomSelect.value) {
                      opt.classList.add('selected');
                  } else {
                      opt.classList.remove('selected');
                  }
              });
          }
      };
  }

  const customZoom = initCustomZoomDropdown();

  zoomSelect.value = '1'; // Explicitly set to 100% on page load
  customZoom.update();

  const createMobilePlaceholder = () => {
    const placeholder = document.createElement('div');
    placeholder.className = 'pdf-mobile-placeholder';
    placeholder.innerHTML = `
      <button class="pdf-mobile-open-btn" type="button" aria-label="Open PDF in viewer">
        <span class="pdf-mobile-btn-text">Open PDF</span>
        <svg class="pdf-mobile-btn-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" d="M9.79 12.79L4 18.59V17a1 1 0 0 0-2 0v4a1 1 0 0 0 .08.38a1 1 0 0 0 .54.54A1 1 0 0 0 3 22h4a1 1 0 0 0 0-2H5.41l5.8-5.79a1 1 0 0 0-1.42-1.42M21.92 2.62a1 1 0 0 0-.54-.54A1 1 0 0 0 21 2h-4a1 1 0 0 0 0 2h1.59l-5.8 5.79a1 1 0 0 0 0 1.42a1 1 0 0 0 1.42 0L20 5.41V7a1 1 0 0 0 2 0V3a1 1 0 0 0-.08-.38"></path>
        </svg>
      </button>
    `;

    // Temp fix for mobile placeholder
    // placeholder.innerHTML = `
    //   <a href="${url}" target="_blank" class="pdf-mobile-open-btn" style="display: flex; text-decoration: none;">
    //     <span class="pdf-mobile-btn-text">Open PDF</span>
    //     <svg class="pdf-mobile-btn-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    //       <path fill="currentColor" d="M9.79 12.79L4 18.59V17a1 1 0 0 0-2 0v4a1 1 0 0 0 .08.38a1 1 0 0 0 .54.54A1 1 0 0 0 3 22h4a1 1 0 0 0 0-2H5.41l5.8-5.79a1 1 0 0 0-1.42-1.42M21.92 2.62a1 1 0 0 0-.54-.54A1 1 0 0 0 21 2h-4a1 1 0 0 0 0 2h1.59l-5.8 5.79a1 1 0 0 0 0 1.42a1 1 0 0 0 1.42 0L20 5.41V7a1 1 0 0 0 2 0V3a1 1 0 0 0-.08-.38"></path>
    //     </svg>
    //   </a>
    // `;

    const openBtn = placeholder.querySelector('.pdf-mobile-open-btn');
    openBtn.addEventListener('click', () => {
      zoomMode = 'width';
      zoomSelect.value = 'width';
      
      expandBtn.click();
    });
    
    return placeholder;
  };

  const mobilePlaceholder = createMobilePlaceholder();
  canvasContainer.appendChild(mobilePlaceholder);

  async function downloadPDF() {
    const filename = getDecodedFilename(url);
    try {
      let blob;
      // Use PDF.js data if available
      if (pdfDoc) {
        const data = await pdfDoc.getData();
        blob = new Blob([data], { type: 'application/pdf' });
      } 
      else {
        const response = await fetch(url);
        blob = await response.blob();
      }
      
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      
      setTimeout(() => {
        if (document.body.contains(link)) {
          document.body.removeChild(link);
        }
        URL.revokeObjectURL(link.href);
      }, 100);
    } catch (error) {
      // [DEBUGGING CODE]
      // console.error('PDF download failed:', error);
      alert('Download failed. Please try again.');
    }
  }

  function calculateScale(base) {
    if (zoomMode === 'fit') {
      zoom = canvasContainer.clientHeight / base.height;
      currentZoom = zoom;
      return zoom;
    } else if (zoomMode === 'width') {
      zoom = canvasContainer.clientWidth / base.width;
      currentZoom = zoom;
      return zoom;
    } else if (zoomMode === 'auto') {
      zoom = 1.1;
      currentZoom = zoom;
      return zoom;
    }
    return zoom;
  }

  async function renderPages(skipScrollToPage = false) {
    if (!pdfDoc) return;
    
    const prevScrollState = {
      top: canvasContainer.scrollTop,
      height: pagesContainer.scrollHeight,
      pageNum: pageNum
    };
    
    pagesContainer.innerHTML = '';
    virtualPageManager.destroy();
    await virtualPageManager.initialize();
    
    let createdPages = 0;
    const totalPages = pdfDoc.numPages;
    
    const canvasCreationTasks = Array.from(
      { length: totalPages }, 
      (_, i) => () => createPageCanvas(i + 1)
    );
    
    await runTasksBatched(canvasCreationTasks);
    
    async function createPageCanvas(pageNum) {
      try {
        const canvas = document.createElement('canvas');
        canvas.dataset.page = pageNum;
        canvas.classList.add('pdf-page');
        pagesContainer.appendChild(canvas);
        
        const page = await pdfDoc.getPage(pageNum);
        const base = page.getViewport({ scale: 1 });
        const scale = calculateScale(base);
        const viewport = page.getViewport({ scale });
        
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        
        virtualPageManager.addPage(pageNum, canvas, page, viewport);
        
        createdPages++;
        if (createdPages === totalPages) {
          const newHeight = pagesContainer.scrollHeight;
          const scrollRatio = prevScrollState.height ? prevScrollState.top / prevScrollState.height : 0;
          canvasContainer.scrollTop = Math.floor(newHeight * scrollRatio);
          
          updatePageDisplay(prevScrollState.pageNum);
        }
      } catch (error) {
        // [DEBUGGING CODE]
        // console.warn(`Failed to create page ${pageNum}:`, error);
      }
    }
    
    pageCountSpan.textContent = totalPages;
  }

  function repositionScroll() {
      requestAnimationFrame(() => {
        const scaleRatio = zoom / oldZoom;
        canvasContainer.scrollLeft = oldScrollLeft * scaleRatio;
        
        const pages = pagesContainer.querySelectorAll('.pdf-page');
        if (pages.length === 0) return;
        
        const oldPageHeight = pages[0].height / zoom * oldZoom;
        
        let accumulatedHeight = 0;
        let currentPageIndex = 0;
        
        for (let i = 0; i < pages.length; i++) {
          const pageHeight = oldPageHeight;
          const totalPageHeight = pageHeight + (i < pages.length - 1 ? pageMarginBottom : 0);
          
          if (oldScrollTop < accumulatedHeight + pageHeight) {
            currentPageIndex = i;
            break;
          }
          accumulatedHeight += totalPageHeight;
          currentPageIndex = i + 1;
        }
        
        const scrollWithinPage = oldScrollTop - accumulatedHeight;
        const newPageHeight = pages[0].height;
        let newAccumulatedHeight = 0;
        
        for (let i = 0; i < currentPageIndex; i++) {
          newAccumulatedHeight += newPageHeight + (i < pages.length - 1 ? pageMarginBottom : 0);
        }
        
        const newScrollWithinPage = scrollWithinPage * scaleRatio;
        canvasContainer.scrollTop = newAccumulatedHeight + newScrollWithinPage;
      });
    }
  
    function scrollToPage(num) {
      const target = pagesContainer.querySelector(`canvas[data-page="${num}"]`);
      if (target) {
        canvasContainer.scrollTop = (target.height * (num - 1)) + (pageMarginBottom * (num - 1));
      }
      updatePageDisplay(num);
      scrollSidebarThumbIntoView(num);
    }
  
    function isElementInView(container, element) {
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      return (
        elementRect.top >= containerRect.top &&
        elementRect.bottom <= containerRect.bottom
      );
    }
  
    let sidebarScrollState = {
      scrollTop: 0,
      mode: 'restore'
    };
  
    function scrollSidebarThumbIntoView(pageNum) {
      const thumb = sidebar.querySelector(`.pdf-thumb[data-page="${pageNum}"]`)?.parentElement;
      if (!thumb) return;
      const sidebarRect = sidebar.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      if (thumbRect.top < sidebarRect.top) {
        sidebar.scrollTop += thumbRect.top - sidebarRect.top;
      }
      else if (thumbRect.bottom > sidebarRect.bottom) {
        sidebar.scrollTop += thumbRect.bottom - sidebarRect.bottom;
      }
    }
  
    function updatePageDisplay(num) {
      pageNum = num;
      pageNumInput.value = num;
      document.querySelectorAll('.pdf-thumb').forEach((t, idx) => {
        t.classList.toggle('active', idx + 1 === num);
      });
    }
  
    let updatePageTimeout;
    async function updateCurrentPage() {
      if (updatePageTimeout) {
        cancelAnimationFrame(updatePageTimeout);
      }
      
      updatePageTimeout = requestAnimationFrame(async () => {
        await yieldToMain();
        
        const pages = pagesContainer.querySelectorAll('.pdf-page');
        let current = pageNum;
        
        for (const p of pages) {
          const pageTop = p.offsetTop;
          const pageHeight = p.clientHeight;
          const scrollPosition = canvasContainer.scrollTop;
          const containerHeight = canvasContainer.clientHeight;
          
          if (pageTop + pageHeight / 2 > scrollPosition && 
              pageTop < scrollPosition + containerHeight) {
            current = parseInt(p.dataset.page, 10);
            break;
          }
        }
        
        if (current !== pageNum) {
          requestAnimationFrame(() => {
            updatePageDisplay(current);
            scrollSidebarThumbIntoView(current);
          });
        }
      });
    }
  
    async function renderSidebar() {
      sidebar.innerHTML = '';
      
      await yieldToMain();
      
      const renderThumbnailTask = async (pageNum) => {
        try {
          if (pageNum % 3 === 0) {
            await yieldToMain();
          }
          
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 0.15 });
          
          const thumbWrapper = document.createElement('div');
          thumbWrapper.classList.add('pdf-thumb-wrapper');
          
          const canvas = document.createElement('canvas');
          canvas.setAttribute('aria-label', `Go to page ${pageNum}`);
          canvas.setAttribute('tabindex', '0');
          canvas.setAttribute('role', 'button');
          // Use integer coordinates for thumbnails
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.classList.add('pdf-thumb');
          canvas.dataset.page = pageNum;
          
          if (pageNum === pageNum) canvas.classList.add('active');

          canvas.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              await yieldToMain();
              scrollToPage(pageNum);
            }
          });
          
          canvas.addEventListener('click', async () => {
            await yieldToMain();
            scrollToPage(pageNum);
          }, { passive: true });
          
          thumbWrapper.appendChild(canvas);
          
          const label = document.createElement('span');
          label.classList.add('pdf-thumb-label');
          label.textContent = pageNum;
          thumbWrapper.appendChild(label);
          
          sidebar.appendChild(thumbWrapper);
          
          const ctx = canvas.getContext('2d', { 
            alpha: false,
            desynchronized: true
          });
          
          await page.render({ 
            canvasContext: ctx, 
            viewport: viewport 
          }).promise;
          
        } catch (error) {
          // [DEBUGGING CODE]
          // console.warn(`Failed to render thumbnail for page ${pageNum}:`, error);
        }
      };
      
      const thumbnailTasks = Array.from(
        { length: pdfDoc.numPages }, 
        (_, i) => () => renderThumbnailTask(i + 1)
      );
      
      // Render thumbnails in smaller batches with more frequent yielding for better INP
      await runTasksBatched(thumbnailTasks, 2, 12);
    }
  
    canvasContainer.addEventListener('scroll', updateCurrentPage, { passive: true });
  
    pdfjsLib.getDocument(url).promise.then(async (pdf) => {
      pdfDoc = pdf;
      pageCountSpan.textContent = pdfDoc.numPages;
      
      zoomSelect.value = '1';
      
      await yieldToMain();
      
      const renderPagesPromise = renderPages();
      await yieldToMain();
      const renderSidebarPromise = renderSidebar();
      
      await Promise.all([renderPagesPromise, renderSidebarPromise]);
    }).catch(err => { 
      // [DEBUGGING CODE]
      // console.error('Failed to load PDF:', err);
    });
  
    prevBtn.addEventListener('click', async () => {
      if (pageNum <= 1) return;
      
      prevBtn.disabled = true;
      await yieldToMain();
      scrollToPage(pageNum - 1);
      prevBtn.disabled = false;
    }, { passive: true });
  
    nextBtn.addEventListener('click', async () => {
      if (pageNum >= pdfDoc.numPages) return;
      
      nextBtn.disabled = true;
      await yieldToMain();
      scrollToPage(pageNum + 1);
      nextBtn.disabled = false;
    }, { passive: true });
  
    pageNumInput.addEventListener('change', async () => {
      const n = parseInt(pageNumInput.value, 10);
      if (!isNaN(n) && n >= 1 && n <= pdfDoc.numPages) {
        await yieldToMain();
        scrollToPage(n);
      } else {
        pageNumInput.value = pageNum;
      }
    });
  
    zoomInBtn.addEventListener('click', async () => {
      // Prevent multiple rapid clicks
      if (zoomInBtn.disabled) return;
      zoomInBtn.disabled = true;
      
      oldZoom = zoom;
      oldScrollLeft = canvasContainer.scrollLeft;
      oldScrollTop = canvasContainer.scrollTop;
  
      if (zoomMode !== 'custom') {
        zoom = Math.floor(currentZoom / 0.25) * 0.25;
        zoomMode = 'custom';
      }
      zoom = Math.min(zoom + 0.25, 3);
      zoomSelect.value = zoom;

      customZoom.update(); 
      
      await yieldToMain();
      await renderPages(true);
      
      const repositionTask = () => {
        repositionScroll();
        zoomInBtn.disabled = false;
      };
      
      if (globalThis.scheduler?.postTask) {
        scheduler.postTask(repositionTask, { priority: 'user-visible' });
      } else {
        requestAnimationFrame(repositionTask);
      }
    }, { passive: true });
  
    zoomOutBtn.addEventListener('click', async () => {
      // Prevent multiple rapid clicks
      if (zoomOutBtn.disabled) return;
      zoomOutBtn.disabled = true;
      
      oldZoom = zoom;
      oldScrollLeft = canvasContainer.scrollLeft;
      oldScrollTop = canvasContainer.scrollTop;
      
      if (zoomMode !== 'custom') {
        zoom = Math.ceil(currentZoom / 0.25) * 0.25;
        zoomMode = 'custom';
      }
      zoom = Math.max(zoom - 0.25, 0.25);
      zoomSelect.value = zoom;

      customZoom.update(); 
      
      await yieldToMain();
      await renderPages(true);
      
      const repositionTask = () => {
        repositionScroll();
        zoomOutBtn.disabled = false;
      };
      
      if (globalThis.scheduler?.postTask) {
        scheduler.postTask(repositionTask, { priority: 'user-visible' });
      } else {
        requestAnimationFrame(repositionTask);
      }
    }, { passive: true });
  
    zoomSelect.addEventListener('change', async () => {
      oldZoom = zoom;
      oldScrollLeft = canvasContainer.scrollLeft;
      oldScrollTop = canvasContainer.scrollTop;
      const val = zoomSelect.value;
      
      if (val === 'fit' || val === 'width' || val === 'auto') {
        zoomMode = val;
      } else {
        zoomMode = 'custom';
        zoom = parseFloat(val);
        currentZoom = zoom;
      }

      customZoom.update(); 
      
      await yieldToMain();
      await renderPages(true);
      
      if (globalThis.scheduler?.postTask) {
        scheduler.postTask(() => repositionScroll(), { priority: 'user-visible' });
      } else {
        requestAnimationFrame(() => repositionScroll());
      }
    });
  
    downloadBtn.addEventListener('click', async () => {
      await downloadPDF();
    });

    printBtn.addEventListener('click', async () => {
      try {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
        if (isMobile) {
          // For mobile, open PDF in a new tab for proper printing
          window.open(url, '_blank');
        } else {
          const response = await fetch(url);
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
    
          const iframe = document.createElement("iframe");
          iframe.style.position = "fixed";
          iframe.style.right = "100%";
          iframe.style.bottom = "100%";
          iframe.src = blobUrl;
    
          iframe.onload = () => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            
            setTimeout(() => {
              URL.revokeObjectURL(blobUrl);
              if (document.body.contains(iframe)) {
                document.body.removeChild(iframe);
              }
            }, 600000);
          };
    
          iframe.onerror = () => {
            // [DEBUGGING CODE]
            // console.error('Failed to load PDF in iframe');
            URL.revokeObjectURL(blobUrl);
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
          };
    
          document.body.appendChild(iframe);
        }
      } catch (error) {
        // [DEBUGGING CODE]
        // console.error('Print failed:', error);
      }
    });
  
    sidebarToggle.addEventListener('click', () => {
      oldZoom = zoom;
      oldScrollLeft = canvasContainer.scrollLeft;
      oldScrollTop = canvasContainer.scrollTop;
            
      sidebar.classList.toggle('open');
      
      if (sidebar.classList.contains('open')) {
        sidebar.addEventListener(
          'transitionend',
          () => {
            const selectedThumb = sidebar.querySelector('.pdf-thumb.active')?.parentElement;
            if (selectedThumb) {
              sidebar.scrollTop = selectedThumb.offsetTop - 
                (sidebar.clientHeight / 2) + (selectedThumb.clientHeight / 2);
            }
            
            renderPages(true);
            repositionScroll();
          },
          { once: true }
        );
      } else {
        sidebar.addEventListener(
          'transitionend',
          () => {
            renderPages(true);
            repositionScroll();
          },
          { once: true }
        );
      }
    });
  
    expandBtn.addEventListener('click', () => {
        if (!modal) {
            const currentPageElement = pagesContainer.querySelector(`canvas[data-page="${pageNum}"]`);
            const scrollTopWithinPage = canvasContainer.scrollTop - (currentPageElement?.offsetTop || 0);
            const scrollLeftWithinPage = canvasContainer.scrollLeft - (currentPageElement?.offsetLeft || 0);

            const frameState = {
                pageNum,
                zoom,
                zoomMode,
                scrollLeft: canvasContainer.scrollLeft,
                scrollTop: canvasContainer.scrollTop,
                scrollTopWithinPage,
                scrollLeftWithinPage,
                pageHeight: currentPageElement?.height || 0,
                pageWidth: currentPageElement?.width || 0,
                sidebarOpen: sidebar.classList.contains('open'),
                customZoomValue: zoomSelect.value
            };
  
            modal = document.createElement('div');
            modal.id = 'pdf-modal';
            
            const modalFrame = frame.cloneNode(true);
            modal.appendChild(modalFrame);
            document.body.appendChild(modal);
            document.body.classList.add('no-scroll');
            
            expandBtn.textContent = '✕';
            expandBtn.title = 'Close';
            expandBtn.setAttribute('aria-label', 'Close PDF viewer');
            expandBtn.blur();
  
            const modalViewer = modalFrame.querySelector('#pdf-viewer');
            const modalPagesContainer = modalFrame.querySelector('#pdf-pages');
            const modalCanvasContainer = modalFrame.querySelector('#pdf-canvas-container');
            const modalPageNumInput = modalFrame.querySelector('#pdf-page-num');
            const modalPageCountSpan = modalFrame.querySelector('#pdf-page-count');
            const modalPrevBtn = modalFrame.querySelector('#pdf-prev');
            const modalNextBtn = modalFrame.querySelector('#pdf-next');
            const modalZoomInBtn = modalFrame.querySelector('#pdf-zoom-in');
            const modalZoomOutBtn = modalFrame.querySelector('#pdf-zoom-out');
            const modalZoomSelect = modalFrame.querySelector('#pdf-zoom-select');
            const modalDownloadBtn = modalFrame.querySelector('#pdf-download');
            const modalPrintBtn = modalFrame.querySelector('#pdf-print');
            const modalSidebar = modalFrame.querySelector('#pdf-sidebar');
            const modalSidebarToggle = modalFrame.querySelector('#pdf-sidebar-toggle');
  
            const modalCustomDropdown = modalFrame.querySelector('.custom-zoom-dropdown');
            const modalDropdownTrigger = modalCustomDropdown.querySelector('.dropdown-trigger');
            const modalSelectedValue = modalCustomDropdown.querySelector('.selected-value');
            const modalDropdownOptions = modalCustomDropdown.querySelector('.dropdown-options');

            function updateModalDropdown() {
                modalSelectedValue.textContent = getZoomText(modalZoomSelect.value);

                modalDropdownOptions.querySelectorAll('li').forEach(opt => {
                    if (opt.dataset.value === modalZoomSelect.value) {
                        opt.classList.add('selected');
                    } else {
                        opt.classList.remove('selected');
                    }
                });
            }
            
            modalDropdownTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                modalDropdownOptions.classList.toggle('show');
            });

            modalDropdownOptions.addEventListener('click', (e) => {
                const option = e.target.closest('li');
                if (!option) return;
                
                const value = option.dataset.value;
                modalZoomSelect.value = value;
                modalSelectedValue.textContent = getZoomText(value);
                modalDropdownOptions.classList.remove('show');

                option.classList.add('selected');
                modalDropdownOptions.querySelectorAll('li').forEach(opt => {
                    if (opt !== option) {
                        opt.classList.remove('selected');
                    }
                });
                
                modalZoomSelect.dispatchEvent(new Event('change'));
            });

            document.addEventListener('click', (e) => {
                if (!modalCustomDropdown.contains(e.target)) {
                    modalDropdownOptions.classList.remove('show');
                }
            });

            updateModalDropdown();

            modalZoomSelect.value = frameState.zoomMode === 'custom' ? 
              frameState.zoom.toString() : 
              frameState.zoomMode;
            updateModalDropdown();

            let modalPageNum = frameState.pageNum;
            let modalZoom = frameState.zoom;
            let modalZoomMode = frameState.zoomMode;
            let modalOldZoom = frameState.zoom;
            let modalOldScrollLeft = frameState.scrollLeft;
            let modalOldScrollTop = frameState.scrollTop;
            let modalSidebarScrollState = null;
  
            const modalVirtualPageManager = new VirtualPageManager(modalPagesContainer, modalCanvasContainer);
  
            function calculateModalZoom(base) {
              if (modalZoomMode === 'fit') {
                  modalZoom = modalCanvasContainer.clientHeight / base.height;
                  return modalZoom;
              } else if (modalZoomMode === 'width') {
                  const availableWidth = modalCanvasContainer.clientWidth;
                  modalZoom = availableWidth / base.width;
                  return modalZoom;
              } else if (modalZoomMode === 'auto') {
                  modalZoom = 1.1;
                  return modalZoom;
              }
              return modalZoom;
            }
  
            async function renderModalPages(skipScrollToPage = false) {
              if (!pdfDoc) return;
              const currentPage = modalPageNum;
              modalPagesContainer.innerHTML = '';
              modalVirtualPageManager.destroy();
              await modalVirtualPageManager.initialize();
              
              const canvasCreationTasks = [];
              for (let i = 1; i <= pdfDoc.numPages; i++) {
                  canvasCreationTasks.push(() => createModalPageCanvas(i));
              }
              
              await runTasksBatched(canvasCreationTasks, 2, 10);
              
              async function createModalPageCanvas(pageNum) {
                try {
                  const canvas = document.createElement('canvas');
                  canvas.dataset.page = pageNum;
                  canvas.classList.add('pdf-page');
                  modalPagesContainer.appendChild(canvas);
                  
                  const page = await pdfDoc.getPage(pageNum);
                  const base = page.getViewport({ scale: 1 });
                  const scale = calculateModalZoom(base);
                  const viewport = page.getViewport({ scale });
                  
                  canvas.width = Math.floor(viewport.width);
                  canvas.height = Math.floor(viewport.height);
                  canvas.style.width = Math.floor(viewport.width) + 'px';
                  canvas.style.height = Math.floor(viewport.height) + 'px';
                  
                  modalVirtualPageManager.addPage(pageNum, canvas, page, viewport);
                } catch (error) {
                  // [DEBUGGING CODE]
                  // console.warn(`Failed to create modal page ${pageNum}:`, error);
                }
              }
              
              if (!skipScrollToPage) {
                requestAnimationFrame(() => {
                    const target = modalPagesContainer.querySelector(`canvas[data-page="${currentPage}"]`);
                    if (target) {
                        let scrollTop = target.offsetTop;
                        let scrollLeft = 0;
                        
                        if (frameState.pageHeight && frameState.scrollTopWithinPage) {
                            scrollTop += frameState.scrollTopWithinPage * 
                                        (target.height / frameState.pageHeight);
                        }
                        
                        if (frameState.pageWidth && frameState.scrollLeftWithinPage) {
                            scrollLeft = frameState.scrollLeftWithinPage * 
                                        (target.width / frameState.pageWidth);
                        }
                        
                        modalCanvasContainer.scrollTop = scrollTop;
                        modalCanvasContainer.scrollLeft = scrollLeft;
                    }
                    updateModalPageDisplay(currentPage);
                });
              }
            }
  
            function repositionModalScroll() {
              requestAnimationFrame(() => {
                const scaleRatio = modalZoom / modalOldZoom;
                modalCanvasContainer.scrollLeft = modalOldScrollLeft * scaleRatio;
                
                const pages = modalPagesContainer.querySelectorAll('.pdf-page');
                if (pages.length === 0) return;
                
                const oldPageHeight = pages[0].height / modalZoom * modalOldZoom;
                
                let accumulatedHeight = 0;
                let currentPageIndex = 0;
                
                for (let i = 0; i < pages.length; i++) {
                  const pageHeight = oldPageHeight;
                  const totalPageHeight = pageHeight + (i < pages.length - 1 ? pageMarginBottom : 0);
                  
                  if (modalOldScrollTop < accumulatedHeight + pageHeight) {
                    currentPageIndex = i;
                    break;
                  }
                  accumulatedHeight += totalPageHeight;
                  currentPageIndex = i + 1;
                }
                
                const scrollWithinPage = modalOldScrollTop - accumulatedHeight;
                const newPageHeight = pages[0].height;
                let newAccumulatedHeight = 0;
                
                for (let i = 0; i < currentPageIndex; i++) {
                  newAccumulatedHeight += newPageHeight + (i < pages.length - 1 ? pageMarginBottom : 0);
                }
                
                const newScrollWithinPage = scrollWithinPage * scaleRatio;
                modalCanvasContainer.scrollTop = newAccumulatedHeight + newScrollWithinPage;
              });
            }
  
            function updateModalPageDisplay(num) {
                modalPageNum = num;
                modalPageNumInput.value = num;
                modalSidebar.querySelectorAll('.pdf-thumb').forEach((t, idx) => {
                    t.classList.toggle('active', idx + 1 === num);
                });
                scrollModalSidebarThumbIntoView(num);
            }
  
            function scrollModalSidebarThumbIntoView(pageNum) {
                const thumb = modalSidebar.querySelector(`.pdf-thumb[data-page="${pageNum}"]`)?.parentElement;
                if (!thumb) return;
                
                modalSidebar.scrollTop = thumb.offsetTop - 
                    (modalSidebar.clientHeight / 2) + (thumb.clientHeight / 2);
            }
  
            function scrollModalToPage(num) {
                const target = modalPagesContainer.querySelector(`canvas[data-page="${num}"]`);
                if (target) {
                    modalCanvasContainer.scrollTop = (target.height * (num - 1)) + (pageMarginBottom * (num - 1));
                }
                updateModalPageDisplay(num);
            }
  
            let modalUpdatePageTimeout;
            async function updateModalCurrentPage() {
                if (modalUpdatePageTimeout) {
                  cancelAnimationFrame(modalUpdatePageTimeout);
                }
                
                modalUpdatePageTimeout = requestAnimationFrame(async () => {
                  await yieldToMain();
                  
                  const pages = modalPagesContainer.querySelectorAll('.pdf-page');
                  let current = modalPageNum;
                  for (const p of pages) {
                      if (p.offsetTop + p.clientHeight / 2 > modalCanvasContainer.scrollTop) {
                          current = parseInt(p.dataset.page, 10);
                          break;
                      }
                  }
                  if (current !== modalPageNum) {
                      updateModalPageDisplay(current);
                  }
                });
            }
  
            modalCanvasContainer.addEventListener('scroll', updateModalCurrentPage, { passive: true });
  
            if (pdfDoc) {
                modalPageCountSpan.textContent = pdfDoc.numPages;
                modalPageNumInput.value = modalPageNum;
                modalZoomSelect.value = modalZoom;
                
                if (frameState.sidebarOpen) {
                    modalSidebar.classList.add('open');
                }
                
                modalVirtualPageManager.initialize().then(() => {
                  renderModalPages();
                  
                  modalSidebar.innerHTML = '';
                  const thumbnailTasks = [];
                  for (let i = 1; i <= pdfDoc.numPages; i++) {
                    thumbnailTasks.push(() => createModalThumbnail(i));
                  }
                  runTasksBatched(thumbnailTasks, 2, 10);
                  
                  async function createModalThumbnail(i) {
                    try {
                      const p = await pdfDoc.getPage(i);
                      const v = p.getViewport({ scale: 0.2 });
                      const thumbWrapper = document.createElement('div');
                      thumbWrapper.classList.add('pdf-thumb-wrapper');
                      const c = document.createElement('canvas');
                      c.setAttribute('aria-label', `Go to page ${i}`);
                      c.setAttribute('tabindex', '0');
                      c.setAttribute('role', 'button');
                      c.width = v.width;
                      c.height = v.height;
                      c.classList.add('pdf-thumb');
                      c.dataset.page = i;
                      if (i === modalPageNum) c.classList.add('active');
                      c.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          scrollModalToPage(i);
                        }
                      });
                      c.addEventListener('click', () => scrollModalToPage(i), { passive: true });
                      thumbWrapper.appendChild(c);
                      const label = document.createElement('span');
                      label.classList.add('pdf-thumb-label');
                      label.textContent = i;
                      thumbWrapper.appendChild(label);
                      modalSidebar.appendChild(thumbWrapper);
                      await p.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
                    } catch (error) {
                      // [DEBUGGING CODE]
                      // console.warn(`Failed to render modal thumbnail ${i}:`, error);
                    }
                  }
                });
  
                // Attach event listeners to modal controls
                modalPrevBtn.addEventListener('click', async () => {
                    if (modalPageNum > 1) {
                        await yieldToMain();
                        scrollModalToPage(modalPageNum - 1);
                    }
                });
  
                modalNextBtn.addEventListener('click', async () => {
                    if (modalPageNum < pdfDoc.numPages) {
                        await yieldToMain();
                        scrollModalToPage(modalPageNum + 1);
                    }
                });
  
                modalPageNumInput.addEventListener('change', async () => {
                    const n = parseInt(modalPageNumInput.value);
                    if (!isNaN(n) && n >= 1 && n <= pdfDoc.numPages) {
                        await yieldToMain();
                        scrollModalToPage(n);
                    } else {
                        modalPageNumInput.value = modalPageNum;
                    }
                });
  
                modalZoomInBtn.addEventListener('click', async () => {
                    modalOldZoom = modalZoom;
                    modalOldScrollLeft = modalCanvasContainer.scrollLeft;
                    modalOldScrollTop = modalCanvasContainer.scrollTop;
  
                    if (modalZoomMode !== 'custom') {
                        modalZoom = Math.floor(modalZoom / 0.25) * 0.25;
                        modalZoomMode = 'custom';
                    }
                    modalZoom = Math.min(modalZoom + 0.25, 3);
                    modalZoomSelect.value = modalZoom;

                    updateModalDropdown();
                    
                    await yieldToMain();
                    await renderModalPages(true);
                    repositionModalScroll();
                });
  
                modalZoomOutBtn.addEventListener('click', async () => {
                    modalOldZoom = modalZoom;
                    modalOldScrollLeft = modalCanvasContainer.scrollLeft;
                    modalOldScrollTop = modalCanvasContainer.scrollTop;
  
                    if (modalZoomMode !== 'custom') {
                        modalZoom = Math.ceil(modalZoom / 0.25) * 0.25;
                        modalZoomMode = 'custom';
                    }
                    modalZoom = Math.max(modalZoom - 0.25, 0.25);
                    modalZoomSelect.value = modalZoom;

                    updateModalDropdown();
                    
                    await yieldToMain();
                    await renderModalPages(true);
                    repositionModalScroll();
                });
  
                modalZoomSelect.addEventListener('change', async () => {
                    modalOldZoom = modalZoom;
                    modalOldScrollLeft = modalCanvasContainer.scrollLeft;
                    modalOldScrollTop = modalCanvasContainer.scrollTop;
                    
                    const val = modalZoomSelect.value;
                    modalZoomMode = (val === 'fit' || val === 'width' || val === 'auto') ? val : 'custom';
                    
                    const page = await pdfDoc.getPage(1);
                    const base = page.getViewport({ scale: 1 });
                    if (val === 'fit' || val === 'width' || val === 'auto') {
                        modalZoom = calculateModalZoom(base);
                    } else {
                        modalZoom = parseFloat(val);
                    }

                    updateModalDropdown();
                    
                    await yieldToMain();
                    await renderModalPages(true);
                    repositionModalScroll();
                });
  
                modalDownloadBtn.addEventListener('click', async () => {
                  await downloadPDF();
                });
  
                modalPrintBtn.addEventListener('click', async () => {
                    try {
                      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
                      if (isMobile) {
                        window.open(url, '_blank');
                      } else {
                        const response = await fetch(url);
                        const blob = await response.blob();
                        const blobUrl = URL.createObjectURL(blob);
    
                        const iframe = document.createElement("iframe");
                        iframe.style.position = "fixed";
                        iframe.style.right = "100%";
                        iframe.style.bottom = "100%";
                        iframe.src = blobUrl;
    
                        iframe.onload = () => {
                          iframe.contentWindow.focus();
                          iframe.contentWindow.print();
                          
                          setTimeout(() => {
                            URL.revokeObjectURL(blobUrl);
                            if (document.body.contains(iframe)) {
                              document.body.removeChild(iframe);
                            }
                          }, 600000);
                        };
    
                        iframe.onerror = () => {
                          // [DEBUGGING CODE]
                          // console.error('Failed to load PDF in iframe');
                          URL.revokeObjectURL(blobUrl);
                          if (document.body.contains(iframe)) {
                            document.body.removeChild(iframe);
                          }
                        };
    
                        document.body.appendChild(iframe);
                      }
                    } catch (error) {
                      // [DEBUGGING CODE]
                      // console.error('Print failed:', error);
                    }
                });
  
                modalSidebarToggle.addEventListener('click', () => {
                  const currentPage = modalPageNum;
                                    
                  modalSidebar.classList.toggle('open');
                  
                  modalSidebar.addEventListener('transitionend', () => {
                      if (modalSidebar.classList.contains('open')) {
                          const selectedThumb = modalSidebar.querySelector('.pdf-thumb.active')?.parentElement;
                          if (selectedThumb) {
                              modalSidebar.scrollTop = selectedThumb.offsetTop - 
                                  (modalSidebar.clientHeight / 2) + (selectedThumb.clientHeight / 2);
                          }
                      }
                      
                      if (modalZoomMode === 'width') {
                          pdfDoc.getPage(1).then(async page => {
                              const base = page.getViewport({ scale: 1 });
                              modalZoom = calculateModalZoom(base);
                              await renderModalPages();
                              scrollModalToPage(currentPage);
                          });
                      }
                  }, { once: true });
              });
  
                window.addEventListener('resize', () => {
                    if (modal && modalZoomMode !== 'custom') {
                        const currentPage = modalPageNum;
                        pdfDoc.getPage(1).then(async page => {
                            const base = page.getViewport({ scale: 1 });
                            modalZoom = calculateModalZoom(base);
                            await renderModalPages();
                            scrollModalToPage(currentPage);
                        });
                    }
                });
            }
  
            const modalExpandBtn = modalFrame.querySelector('#pdf-expand');
            modalExpandBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M6.225 4.811a1 1 0 0 0-1.414 1.414L10.586 12L4.81 17.775a1 1 0 1 0 1.414 1.414L12 13.414l5.775 5.775a1 1 0 0 0 1.414-1.414L13.414 12l5.775-5.775a1 1 0 0 0-1.414-1.414L12 10.586z" stroke-width="1.5" stroke="#fff"/></svg>';
            modalExpandBtn.title = 'Close';
            modalExpandBtn.setAttribute('aria-label', 'Close PDF viewer');
            modalExpandBtn.addEventListener('click', () => {
                const finalState = {
                    pageNum: modalPageNum,
                    zoom: modalZoom,
                    zoomMode: modalZoomMode,
                    sidebarOpen: modalSidebar.classList.contains('open'),
                    scrollLeft: modalCanvasContainer.scrollLeft,
                    scrollTop: modalCanvasContainer.scrollTop
                };
  
                modalVirtualPageManager.destroy();
  
                modal.remove();
                modal = null;
                document.body.classList.remove('no-scroll');
                expandBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M9.79 12.79L4 18.59V17a1 1 0 0 0-2 0v4a1 1 0 0 0 .08.38a1 1 0 0 0 .54.54A1 1 0 0 0 3 22h4a1 1 0 0 0 0-2H5.41l5.8-5.79a1 1 0 0 0-1.42-1.42M21.92 2.62a1 1 0 0 0-.54-.54A1 1 0 0 0 21 2h-4a1 1 0 0 0 0 2h1.59l-5.8 5.79a1 1 0 0 0 0 1.42a1 1 0 0 0 1.42 0L20 5.41V7a1 1 0 0 0 2 0V3a1 1 0 0 0-.08-.38"/></svg>';
                expandBtn.title = 'Expand';
                expandBtn.blur();
  
                pageNum = finalState.pageNum;
                zoom = finalState.zoom;
                zoomMode = finalState.zoomMode;
                
                zoomSelect.value = finalState.zoomMode === 'custom' ? 
                  finalState.zoom.toString() : 
                  finalState.zoomMode;
                pageNumInput.value = finalState.pageNum;

                const selectedValue = document.querySelector('.custom-zoom-dropdown .selected-value');
                if (selectedValue) {
                    selectedValue.textContent = getZoomText(zoomSelect.value);

                    const options = document.querySelectorAll('.custom-zoom-dropdown .dropdown-options li');
                    options.forEach(opt => opt.classList.remove('selected'));
                    const selectedOption = document.querySelector(`.custom-zoom-dropdown .dropdown-options li[data-value="${zoomSelect.value}"]`);
                    if (selectedOption) {
                        selectedOption.classList.add('selected');
                    }
                }
                
                if (finalState.sidebarOpen !== sidebar.classList.contains('open')) {
                    sidebar.classList.toggle('open');
                }
  
                pdfDoc.getPage(1).then(async page => {
                    const base = page.getViewport({ scale: 1 });
                    if (zoomMode !== 'custom') {
                        zoom = calculateScale(base);
                    }
                    
                    await renderPages(true);
                    
                    requestAnimationFrame(() => {
                        canvasContainer.scrollLeft = finalState.scrollLeft;
                        canvasContainer.scrollTop = finalState.scrollTop;
                        updatePageDisplay(finalState.pageNum);
                        scrollSidebarThumbIntoView(finalState.pageNum);
                    });
                });
            });
            
        } else {
            modal.remove();
            modal = null;
            document.body.classList.remove('no-scroll');
            expandBtn.textContent = '⤢';
            expandBtn.title = 'Expand';
        }
    });
  
    let resizeTimeout;
    window.addEventListener('resize', () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      
      resizeTimeout = setTimeout(async () => {
        const resizeTask = async () => {
          await yieldToMain();
          await renderPages();
        };
        
        if (globalThis.scheduler?.postTask) {
          scheduler.postTask(resizeTask, { priority: 'user-visible' });
        } else {
          await resizeTask();
        }
      }, 150);
    }, { passive: true });
  
    window.addEventListener('beforeunload', () => {
      virtualPageManager.destroy();
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (updatePageTimeout) {
        cancelAnimationFrame(updatePageTimeout);
      }
    });
});