const dbName = 'ImageClassifierDB';
const dbVersion = 1;
let db;
let confirmationModal;

// State Management
let imageFiles = []; // Now stores zip entries instead of blobs
let currentIndex = 0;
let results = [];
let currentPage = 1;
let rowsPerPage = 10;
let currentImageUrl = null;
let zipInstance = null;
let saveStateTimeout = null;

// DOM Element References
const zipInput = document.getElementById('zip-input');
const uploadLabel = document.getElementById('upload-label');
const statusText = document.getElementById('status-text');
const displayImage = document.getElementById('display-image');

const uploadSection = document.getElementById('upload-section');
const viewerSection = document.getElementById('viewer-section');
const resultsSection = document.getElementById('results-section');
const yesBtn = document.getElementById('yes-btn');
const problematicBtn = document.getElementById('problematic-btn');
const noBtn = document.getElementById('no-btn');
const backBtn = document.getElementById('back-btn');
const uploadNewBtn = document.querySelector('.upload-new-btn');
const topDownloadBtn = document.getElementById('top-download-btn');
const resultsTableBody = document.querySelector('#results-table tbody');
const paginationControls = document.getElementById('pagination-controls');
const rowsPerPageSelect = document.getElementById('rows-per-page-select');
const confirmationModalEl = document.getElementById('confirmationModal');
const confirmUploadBtn = document.getElementById('confirmUploadBtn');

// --- IndexedDB Functions ---
async function openDB() {
    return idb.openDB(dbName, dbVersion, {
        upgrade(db) {
            db.createObjectStore('state');
        },
    });
}

async function saveState() {
    if (!db) return;
    // Don't save imageFiles with zipEntry objects - they can't be serialized
    const serializableImageFiles = imageFiles.map(file => ({ name: file.name }));
    await db.put('state', { 
        imageFiles: serializableImageFiles, 
        currentIndex, 
        results, 
        rowsPerPage 
    }, 'appState');
}

function debouncedSaveState() {
    if (saveStateTimeout) {
        clearTimeout(saveStateTimeout);
    }
    saveStateTimeout = setTimeout(() => {
        saveState();
    }, 300); // 300ms debounce
}

async function loadState() {
    if (!db) return;
    const savedState = await db.get('state', 'appState');
    if (savedState) {
        // Only restore state if we have a zipInstance to work with
        if (!zipInstance) {
            return false;
        }
        
        // Rebuild imageFiles with zipEntry references
        imageFiles = savedState.imageFiles.map(file => {
            const zipEntry = zipInstance.file(file.name);
            return zipEntry ? { name: file.name, zipEntry } : null;
        }).filter(Boolean);
        
        currentIndex = savedState.currentIndex;
        results = savedState.results;
        if (savedState.rowsPerPage) {
            rowsPerPage = savedState.rowsPerPage;
            rowsPerPageSelect.value = savedState.rowsPerPage;
        }
        return imageFiles.length > 0;
    }
    return false;
}

async function clearCurrentData() {
    console.log('Clearing current data...');
    
    // Clean up current image URL
    if (currentImageUrl) {
        URL.revokeObjectURL(currentImageUrl);
        currentImageUrl = null;
    }
    
    // Clean up result image URLs
    results.forEach(result => {
        if (result.imageUrl) {
            URL.revokeObjectURL(result.imageUrl);
        }
    });
    
    imageFiles = [];
    currentIndex = 0;
    results = [];
    currentPage = 1;
    rowsPerPage = 10;
    zipInstance = null; // Clear ZIP instance
    
    if (db) {
        await db.clear('state');
    }
    
    console.log('Data cleared successfully');
}

function uploadNewFileHandler() {
    confirmationModal.show();
}

function cleanupOnUnload() {
    // Clean up all Object URLs before page unload
    if (currentImageUrl) {
        URL.revokeObjectURL(currentImageUrl);
    }
    results.forEach(result => {
        if (result.imageUrl) {
            URL.revokeObjectURL(result.imageUrl);
        }
    });
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', init);
zipInput.addEventListener('change', handleFileSelect);
uploadLabel.addEventListener('click', () => {
    zipInput.value = ''; // Clear the input to ensure change event fires
    zipInput.click();
});
document.addEventListener('keydown', handleKeyPress);
yesBtn.addEventListener('click', () => classify('Так'));
problematicBtn.addEventListener('click', () => classify('Проблематично визначити'));
noBtn.addEventListener('click', () => classify('Ні'));
backBtn.addEventListener('click', goBack);
uploadNewBtn.addEventListener('click', uploadNewFileHandler);
topDownloadBtn.addEventListener('click', downloadResults);
window.addEventListener('beforeunload', cleanupOnUnload);

rowsPerPageSelect.addEventListener('change', () => {
    rowsPerPage = parseInt(rowsPerPageSelect.value, 10);
    currentPage = 1;
    debouncedSaveState();
    renderResultsTable();
    renderPaginationControls();
});

async function init() {
    confirmationModal = new bootstrap.Modal(confirmationModalEl);
    confirmUploadBtn.addEventListener('click', async () => {
        await clearCurrentData();
        
        resultsSection.classList.add('d-none');
        viewerSection.classList.add('d-none');
        uploadNewBtn.classList.add('d-none');
        topDownloadBtn.classList.add('d-none');
        uploadSection.classList.remove('d-none');
        
        // Clear the file input to allow selecting the same file again
        zipInput.value = '';

        confirmationModal.hide();
    });

    db = await openDB();
    // Note: We can't restore state without a ZIP file, so just show upload section
    uploadSection.classList.remove('d-none');
}

async function handleFileSelect(event) {
    console.log('File select event triggered');
    const file = event.target.files[0];
    if (!file) {
        console.log('No file selected');
        return;
    }
    console.log('Selected file:', file.name, file.size, 'bytes');

    await clearCurrentData();

    statusText.textContent = 'Завантаження ZIP-файлу...';
    viewerSection.classList.remove('d-none');

    try {
        // Non-blocking ZIP loading with progress
        zipInstance = await JSZip.loadAsync(file, {
            createFolders: false
        });
        
        statusText.textContent = 'Обробка зображень...';
        
        // Use setTimeout to make processing non-blocking
        await new Promise(resolve => setTimeout(resolve, 10));
        
        let allPngZipEntries = [];
        zipInstance.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.png')) {
                allPngZipEntries.push(zipEntry);
            }
        });

        if (allPngZipEntries.length > 0) {
            statusText.textContent = `Знайдено ${allPngZipEntries.length} зображень. Фільтрація...`;
            
            // Another non-blocking pause
            await new Promise(resolve => setTimeout(resolve, 10));
            
            let minDepth = -1;
            for (const entry of allPngZipEntries) {
                const depth = (entry.name.split('/').length - 1);
                if (minDepth === -1 || depth < minDepth) {
                    minDepth = depth;
                }
            }
            
            const finalZipEntries = allPngZipEntries.filter(entry => (entry.name.split('/').length - 1) === minDepth);

            // Store zip entries instead of loading all blobs
            imageFiles = finalZipEntries.map(entry => ({
                name: entry.name,
                zipEntry: entry
            }));

            if (imageFiles.length > 0) {
                statusText.textContent = `Готово! Знайдено ${imageFiles.length} зображень для класифікації.`;
                uploadSection.classList.add('d-none');
                uploadNewBtn.classList.remove('d-none');
                topDownloadBtn.disabled = true;
                
                // Try to restore previous state for this ZIP file
                const stateRestored = await loadState();
                await saveState();
                
                if (stateRestored && currentIndex < imageFiles.length) {
                    // Continue from where user left off
                    viewerSection.classList.remove('d-none');
                    topDownloadBtn.classList.remove('d-none');
                    topDownloadBtn.disabled = results.length === 0;
                    displayCurrentImage();
                } else if (stateRestored && currentIndex >= imageFiles.length) {
                    // User had completed classification
                    topDownloadBtn.classList.remove('d-none');
                    topDownloadBtn.disabled = results.length === 0;
                    showCompletionScreen();
                } else {
                    // Start fresh
                    viewerSection.classList.remove('d-none');
                    topDownloadBtn.classList.remove('d-none');
                    topDownloadBtn.disabled = true;
                    await new Promise(resolve => setTimeout(resolve, 500));
                    displayCurrentImage();
                }
            }
        } else {
            statusText.textContent = 'У ZIP-файлі не знайдено зображень PNG на першому рівні.';
        }
    } catch (error) {
        console.error('Error processing ZIP file:', error);
        statusText.textContent = 'Помилка обробки ZIP-файлу. Спробуйте інший файл.';
    }
}

async function displayCurrentImage() {
    // Clean up previous image URL
    if (currentImageUrl) {
        URL.revokeObjectURL(currentImageUrl);
        currentImageUrl = null;
    }
    
    if (currentIndex < imageFiles.length) {
        const imageFile = imageFiles[currentIndex];
        const starId = extractStarId(imageFile.name);
        
        // Lazy load the current image blob
        statusText.textContent = `Завантаження зображення ${currentIndex + 1} з ${imageFiles.length} | TIC ${starId}`;
        
        try {
            const blob = await imageFile.zipEntry.async('blob');
            currentImageUrl = URL.createObjectURL(blob);
            displayImage.src = currentImageUrl;
            statusText.textContent = `Зображення ${currentIndex + 1} з ${imageFiles.length} | TIC ${starId}`;
        } catch (error) {
            console.error('Error loading image:', error);
            statusText.textContent = `Помилка завантаження зображення ${currentIndex + 1} з ${imageFiles.length} | TIC ${starId}`;
        }
    } else {
        showCompletionScreen();
    }
    backBtn.disabled = currentIndex === 0;
}

function handleKeyPress(event) {
    if (currentIndex >= imageFiles.length) return;

    if (event.key === 'ArrowRight') {
        classify('Так');
    } else if (event.key === 'ArrowLeft') {
        classify('Ні');
    } else if (event.key === 'ArrowDown') {
        classify('Проблематично визначити');
    }
}

async function classify(classification) {
    if (currentIndex >= imageFiles.length) return;

    const filename = imageFiles[currentIndex].name;
    const starId = extractStarId(filename);
    
    // Create a new blob URL for results table (don't reuse current one)
    let resultImageUrl = null;
    try {
        const blob = await imageFiles[currentIndex].zipEntry.async('blob');
        resultImageUrl = URL.createObjectURL(blob);
    } catch (error) {
        console.error('Error creating result image URL:', error);
        resultImageUrl = displayImage.src; // fallback to current URL
    }

    results.push({
        starId: starId,
        filename: filename,
        classification: classification,
        imageUrl: resultImageUrl
    });

    currentIndex++;
    topDownloadBtn.disabled = false;
    await saveState();
    displayCurrentImage();
}

async function goBack() {
    if (currentIndex > 0) {
        const lastResult = results.pop();
        if (lastResult && lastResult.imageUrl) {
            URL.revokeObjectURL(lastResult.imageUrl);
        }
        currentIndex--;
        topDownloadBtn.disabled = results.length === 0;
        await saveState();
        displayCurrentImage();
    }
}

function showCompletionScreen() {
    viewerSection.classList.add('d-none');
    resultsSection.classList.remove('d-none');
    renderResultsTable();
    renderPaginationControls();
}

function renderResultsTable() {
    const start = (currentPage - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const paginatedResults = results.slice(start, end);
    
    // Only clear and rebuild if the number of rows has changed
    const currentRows = resultsTableBody.children.length;
    const neededRows = paginatedResults.length;
    
    if (currentRows !== neededRows) {
        resultsTableBody.innerHTML = '';
        
        // Create document fragment for efficient DOM updates
        const fragment = document.createDocumentFragment();
        
        paginatedResults.forEach((result, index) => {
            const resultIndex = start + index;
            const row = createResultRow(result, resultIndex);
            fragment.appendChild(row);
        });
        
        resultsTableBody.appendChild(fragment);
    } else {
        // Update existing rows instead of recreating
        Array.from(resultsTableBody.children).forEach((row, index) => {
            if (index < paginatedResults.length) {
                updateResultRow(row, paginatedResults[index], start + index);
            }
        });
    }
}

function createResultRow(result, resultIndex) {
    const row = document.createElement('tr');
    
    const classificationOptions = ['Так', 'Ні', 'Проблематично визначити'];
    const select = document.createElement('select');
    select.classList.add('form-select');
    select.dataset.resultIndex = resultIndex;

    classificationOptions.forEach(option => {
        const optionElement = document.createElement('option');
        optionElement.value = option;
        optionElement.innerText = option;
        if (option === result.classification) {
            optionElement.selected = true;
        }
        select.appendChild(optionElement);
    });

    select.addEventListener('change', (event) => {
        const newClassification = event.target.value;
        const indexToUpdate = event.target.dataset.resultIndex;
        updateClassification(indexToUpdate, newClassification);
    });

    const classificationClass = getClassificationClass(result.classification);
    const classificationCell = document.createElement('td');
    classificationCell.classList.add(classificationClass);
    classificationCell.appendChild(select);

    const previewCell = document.createElement('td');
    previewCell.innerHTML = `<img src="${result.imageUrl}" class="preview-image img-thumbnail" alt="${result.filename}">`;

    const filenameCell = document.createElement('td');
    filenameCell.innerText = result.starId;

    row.appendChild(previewCell);
    row.appendChild(classificationCell);
    row.appendChild(filenameCell);
    
    return row;
}

function updateResultRow(row, result, resultIndex) {
    const cells = row.children;
    
    // Update preview image
    const img = cells[0].querySelector('img');
    if (img.src !== result.imageUrl) {
        img.src = result.imageUrl;
        img.alt = result.filename;
    }
    
    // Update classification
    const select = cells[1].querySelector('select');
    if (select.value !== result.classification) {
        select.value = result.classification;
        select.dataset.resultIndex = resultIndex;
        
        // Update classification class
        const classificationClass = getClassificationClass(result.classification);
        cells[1].className = '';
        cells[1].classList.add(classificationClass);
    }
    
    // Update star ID
    if (cells[2].innerText !== result.starId) {
        cells[2].innerText = result.starId;
    }
}

function getClassificationClass(classification) {
    switch (classification) {
        case 'Так': return 'classification-yes';
        case 'Ні': return 'classification-no';
        case 'Проблематично визначити': return 'classification-problematic';
        default: return '';
    }
}

async function updateClassification(index, newClassification) {
    results[index].classification = newClassification;
    debouncedSaveState();
    renderResultsTable();
}

function renderPaginationControls() {
    const pageCount = Math.ceil(results.length / rowsPerPage);
    const currentChildren = paginationControls.children.length;
    
    // Only rebuild if page count changed
    if (currentChildren !== pageCount) {
        paginationControls.innerHTML = '';
        
        const fragment = document.createDocumentFragment();
        for (let i = 1; i <= pageCount; i++) {
            const li = createPaginationItem(i);
            fragment.appendChild(li);
        }
        paginationControls.appendChild(fragment);
    } else {
        // Update existing pagination items
        Array.from(paginationControls.children).forEach((li, index) => {
            const pageNum = index + 1;
            li.classList.toggle('active', pageNum === currentPage);
        });
    }
}

function createPaginationItem(pageNum) {
    const li = document.createElement('li');
    li.classList.add('page-item');
    if (pageNum === currentPage) li.classList.add('active');

    const a = document.createElement('a');
    a.classList.add('page-link');
    a.href = '#';
    a.innerText = pageNum;
    a.addEventListener('click', (e) => {
        e.preventDefault();
        if (currentPage !== pageNum) {
            currentPage = pageNum;
            renderResultsTable();
            renderPaginationControls();
        }
    });

    li.appendChild(a);
    return li;
}

function downloadResults() {
    const filteredResults = results.filter(row => 
        row.classification === 'Так' || row.classification === 'Проблематично визначити'
    );

    const data = filteredResults.map(row => ({
        "Номер TIC": row.starId,
        "Відкривач": "",
        "Чи зоря змінна ?": row.classification
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Результати");

    XLSX.writeFile(workbook, "classification_results.xls");
}

function extractStarId(filename) {
    const match = filename.match(/TIC_(\d+)_/);
    return match ? match[1] : 'N/A';
}