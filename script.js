const dbName = 'ImageClassifierDB';
const dbVersion = 2;
let db;
let confirmationModal;
let copySuccessModal;

// State Management
let classificationImages = []; // Array of fileNames for classification
let currentClassificatonImageIndex = 0;
let totalStarsCount = 0; // Total number of stars in database for pagination
let currentPage = 1;
let rowsPerPage = 10;
let currentClassificationImageUrl = null;
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
const topCopyBtn = document.getElementById('top-copy-btn');
const topDownloadBtn = document.getElementById('top-download-btn');
const resultsTableBody = document.querySelector('#results-table tbody');
const paginationControls = document.getElementById('pagination-controls');
const rowsPerPageSelect = document.getElementById('rows-per-page-select');
const confirmationModalEl = document.getElementById('confirmationModal');
const confirmUploadBtn = document.getElementById('confirmUploadBtn');
const copySuccessModalEl = document.getElementById('copySuccessModal');

// Image Modal Elements
const imageModal = document.getElementById('imageModal');
const modalImage = document.getElementById('modalImage');
const closeModal = document.querySelector('.close-modal');


// --- IndexedDB Functions ---

async function openDB() {
    return idb.openDB(dbName, dbVersion, {
        upgrade(db, oldVersion, newVersion, transaction) {
            console.log(`Upgrading database from version ${oldVersion} to ${newVersion}`);

            // V1 schema - keep old object store for rollback
            if (oldVersion < 1) {
                db.createObjectStore('state');
            }

            // V2 schema - optimized structure
            if (oldVersion < 2) {
                // Create images store with fileName as primary key
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'fileName' });
                }

                // Create stars store with fileName as primary key
                if (!db.objectStoreNames.contains('stars')) {
                    db.createObjectStore('stars', { keyPath: 'fileName' });
                }

                // Create appState store for pagination and current state
                if (!db.objectStoreNames.contains('appState')) {
                    db.createObjectStore('appState');
                }

                // Migrate data from V1 to V2 (keeping V1 data intact)
                const v1_stateStore = transaction.objectStore('state');
                const newImagesStore = transaction.objectStore('images');
                const newStarsStore = transaction.objectStore('stars');
                const newAppStateStore = transaction.objectStore('appState');

                const migrationDate = Date.now();

                // Migrate images
                const v1_allImagesRequest = v1_stateStore.get('allImages');
                v1_allImagesRequest.onsuccess = () => {
                    const v1_allImages = v1_allImagesRequest.result;
                    if (v1_allImages) {
                        console.log('Migrating images to v2 schema...');
                        Object.entries(v1_allImages).forEach(([fileName, blob]) => {
                            newImagesStore.put({
                                fileName,
                                image: blob,
                                importDate: migrationDate
                            });
                        });
                    }
                };

                // Migrate app state
                const v1_appStateRequest = v1_stateStore.get('appState');
                v1_appStateRequest.onsuccess = () => {
                    const v1_appState = v1_appStateRequest.result;
                    if (v1_appState) {
                        console.log('Migrating app state to v2 schema...');

                        // Migrate pagination
                        newAppStateStore.put({ rowsPerPage: v1_appState.rowsPerPage || 10 }, 'pagination');

                        // Migrate classification results
                        if (v1_appState.results && Array.isArray(v1_appState.results)) {
                            v1_appState.results.forEach(v1_result => {
                                newStarsStore.put({
                                    fileName: v1_result.filename,
                                    ticId: v1_result.starId,
                                    classification: v1_result.classification
                                });
                            });
                        }

                        // Migrate current position
                        const currentFileName = v1_appState.imageFiles && v1_appState.currentIndex < v1_appState.imageFiles.length
                            ? v1_appState.imageFiles[v1_appState.currentIndex]?.name
                            : null;
                        newAppStateStore.put({ currentFileName }, 'classification');
                    }
                };

                console.log('Migration to v2 complete. V1 data preserved in "state" store for rollback.');
            }
        },
    });
}

async function saveState() {
    if (!db) return;

    const tx = db.transaction('appState', 'readwrite');
    const appState = tx.objectStore('appState');

    // Save pagination settings
    await appState.put({ rowsPerPage }, 'pagination');

    // Save current classification state
    const classificationCurrentFileName = currentClassificatonImageIndex < classificationImages.length ? classificationImages[currentClassificatonImageIndex] : null;
    await appState.put({ classificationCurrentFileName }, 'classification');

    await tx.done;
}

async function saveAllImagesToDB(zipImageEntries) {
    if (!db) return;

    try {
        console.log(`Saving all ${zipImageEntries.length} images to IndexedDB...`);

        const tx = db.transaction(['images', 'stars'], 'readwrite');
        const imagesStore = tx.objectStore('images');
        const starsStore = tx.objectStore('stars');
        const importDate = Date.now();

        for (let i = 0; i < zipImageEntries.length; i++) {
            const imageEntry = zipImageEntries[i];
            if (imageEntry.zipEntry) {
                statusText.textContent = `Збереження зображень: ${i + 1} з ${zipImageEntries.length}`;
                const blob = await imageEntry.zipEntry.async('blob');

                // Save image blob
                await imagesStore.put({
                    fileName: imageEntry.name,
                    image: blob,
                    importDate
                });

                // Create star record with null classification
                const starId = extractStarId(imageEntry.name);
                await starsStore.put({
                    fileName: imageEntry.name,
                    ticId: starId,
                    classification: null
                });
            }
        }

        await tx.done;
        console.log(`Successfully saved ${zipImageEntries.length} images to IndexedDB`);

    } catch (error) {
        console.error('Failed to save images to IndexedDB:', error);
        statusText.textContent = 'Помилка збереження зображень. Спробуйте ще раз.';
    }
}

async function getImageBlobFromDB(fileName) {
    if (!db) return null;

    try {
        const record = await db.get('images', fileName);
        return record ? record.image : null;
    } catch (error) {
        console.warn('Failed to get image from DB:', error);
        return null;
    }
}

async function loadState() {
    if (!db) return false;

    try {
        // Load pagination settings
        const paginationState = await db.get('appState', 'pagination');
        if (paginationState && paginationState.rowsPerPage) {
            rowsPerPage = paginationState.rowsPerPage;
            rowsPerPageSelect.value = paginationState.rowsPerPage;
        }

        // Load all stars (no need to touch images store)
        const starsTx = db.transaction('stars', 'readonly');
        const starsStore = starsTx.objectStore('stars');
        const allStars = await starsStore.getAll();

        if (allStars && allStars.length > 0) {
            // Build classificationImages from stars (just fileNames)
            classificationImages = allStars.map(star => star.fileName);
            totalStarsCount = allStars.length;

            // Load current position
            const classificationState = await db.get('appState', 'classification');
            if (classificationState && classificationState.classificationCurrentFileName) {
                currentClassificatonImageIndex = classificationImages.findIndex(f => f === classificationState.classificationCurrentFileName);
                if (currentClassificatonImageIndex === -1) currentClassificatonImageIndex = 0;
            } else {
                // Count classified stars
                const classifiedCount = allStars.filter(star => star.classification !== null).length;
                currentClassificatonImageIndex = classifiedCount;
            }

            return true;
        }
    } catch (error) {
        console.error('Failed to load state:', error);
    }

    return false;
}

function debouncedSaveState() {
    if (saveStateTimeout) {
        clearTimeout(saveStateTimeout);
    }
    saveStateTimeout = setTimeout(() => {
        saveState();
    }, 300); // 300ms debounce
}


async function clearCurrentData() {
    console.log('Clearing current data...');

    // Clean up current image URL
    if (currentClassificationImageUrl) {
        URL.revokeObjectURL(currentClassificationImageUrl);
        currentClassificationImageUrl = null;
    }

    classificationImages = [];
    currentClassificatonImageIndex = 0;
    totalStarsCount = 0;
    currentPage = 1;
    rowsPerPage = 10;

    if (db) {
        // Clear v2 stores
        await db.clear('images');
        await db.clear('stars');
        await db.clear('appState');

        // Clear v1 store for clean slate
        await db.clear('state');
    }

    console.log('Data cleared successfully');
}

function uploadNewFileHandler() {
    confirmationModal.show();
}

function cleanupOnUnload() {
    // Clean up all Object URLs before page unload
    if (currentClassificationImageUrl) {
        URL.revokeObjectURL(currentClassificationImageUrl);
    }
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
topCopyBtn.addEventListener('click', copyResultsToClipboard);
topDownloadBtn.addEventListener('click', downloadResults);
window.addEventListener('beforeunload', cleanupOnUnload);

resultsTableBody.addEventListener('click', (event) => {
    if (event.target.classList.contains('preview-image')) {
        imageModal.style.display = 'flex';
        modalImage.src = event.target.src;
    }
});

// Image Modal Listeners
displayImage.addEventListener('click', () => {
    if (displayImage.src) {
        imageModal.style.display = 'flex';
        modalImage.src = displayImage.src;
    }
});

closeModal.addEventListener('click', () => {
    imageModal.style.display = 'none';
});

imageModal.addEventListener('click', (e) => {
    if (e.target === imageModal) {
        imageModal.style.display = 'none';
    }
});

rowsPerPageSelect.addEventListener('change', () => {
    rowsPerPage = parseInt(rowsPerPageSelect.value, 10);
    currentPage = 1;
    debouncedSaveState();
    renderFinalResultsTable();
    renderPaginationControls();
});

async function init() {
    confirmationModal = new bootstrap.Modal(confirmationModalEl);
    copySuccessModal = new bootstrap.Modal(copySuccessModalEl);
    confirmUploadBtn.addEventListener('click', async () => {
        await clearCurrentData();
        
        resultsSection.classList.add('d-none');
        viewerSection.classList.add('d-none');
        uploadNewBtn.classList.add('d-none');
        topCopyBtn.classList.add('d-none');
        topDownloadBtn.classList.add('d-none');
        uploadSection.classList.remove('d-none');
        
        // Clear the file input to allow selecting the same file again
        zipInput.value = '';

        confirmationModal.hide();
    });

    db = await openDB();
    
    // Try to restore state from IndexedDB
    const stateRestored = await loadState();
    if (stateRestored) {
        uploadSection.classList.add('d-none');
        uploadNewBtn.classList.remove('d-none');
        topCopyBtn.classList.remove('d-none');
        topDownloadBtn.classList.remove('d-none');

        if (currentClassificatonImageIndex < classificationImages.length) {
            viewerSection.classList.remove('d-none');
            displayCurrentClassificationImage();
        } else {
            resultsSection.classList.remove('d-none');
            showCompletionScreen();
        }
    } else {
        uploadSection.classList.remove('d-none');
    }
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
        const zipInstance = await JSZip.loadAsync(file, {
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

            // Store zip entries as local variable to load images from zip file
            const zipImageEntries = finalZipEntries.map(entry => ({
                name: entry.name,
                zipEntry: entry
            }));

            if (zipImageEntries.length > 0) {
                statusText.textContent = `Готово! Знайдено ${zipImageEntries.length} зображень для класифікації.`;
                uploadSection.classList.add('d-none');
                uploadNewBtn.classList.remove('d-none');
                topCopyBtn.disabled = true;
                topDownloadBtn.disabled = true;

                // Save all images to IndexedDB
                await saveAllImagesToDB(zipImageEntries);

                // Try to restore previous state for this ZIP file
                const stateRestored = await loadState();
                await saveState();

                if (stateRestored && currentClassificatonImageIndex < classificationImages.length) {
                    // Continue from where user left off
                    viewerSection.classList.remove('d-none');
                    topCopyBtn.classList.remove('d-none');
                    topDownloadBtn.classList.remove('d-none');
                    displayCurrentClassificationImage();
                } else if (stateRestored && currentClassificatonImageIndex >= classificationImages.length) {
                    // User had completed classification
                    topCopyBtn.classList.remove('d-none');
                    topDownloadBtn.classList.remove('d-none');
                    showCompletionScreen();
                } else {
                    // Start fresh
                    viewerSection.classList.remove('d-none');
                    topCopyBtn.classList.remove('d-none');
                    topCopyBtn.disabled = true;
                    topDownloadBtn.classList.remove('d-none');
                    topDownloadBtn.disabled = true;
                    await new Promise(resolve => setTimeout(resolve, 500));
                    displayCurrentClassificationImage();
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

async function displayCurrentClassificationImage() {
    // Clean up previous image URL
    if (currentClassificationImageUrl) {
        URL.revokeObjectURL(currentClassificationImageUrl);
        currentClassificationImageUrl = null;
    }

    if (currentClassificatonImageIndex < classificationImages.length) {
        const fileName = classificationImages[currentClassificatonImageIndex];

        try {
            // Get star data from database
            const star = await db.get('stars', fileName);
            if (!star) {
                const errorMsg = `Star not found in database: ${fileName}`;
                console.error(errorMsg);
                alert(errorMsg);
                return;
            }

            const starId = star.ticId;
            statusText.textContent = `Завантаження зображення ${currentClassificatonImageIndex + 1} з ${classificationImages.length} | TIC ${starId}`;

            // Get image from IndexedDB
            const blob = await getImageBlobFromDB(fileName);

            if (blob) {
                currentClassificationImageUrl = URL.createObjectURL(blob);
                displayImage.src = currentClassificationImageUrl;
                statusText.textContent = `Зображення ${currentClassificatonImageIndex + 1} з ${classificationImages.length} | TIC ${starId}`;
            } else {
                const errorMsg = `Image not found in database: ${fileName}`;
                console.error(errorMsg);
                alert(errorMsg);
            }
        } catch (error) {
            const errorMsg = `Error loading image: ${error.message}`;
            console.error(errorMsg, error);
            alert(errorMsg);
            statusText.textContent = `Помилка завантаження зображення ${currentClassificatonImageIndex + 1} з ${classificationImages.length}`;
        }
    } else {
        showCompletionScreen();
    }
    backBtn.disabled = currentClassificatonImageIndex === 0;
}

function handleKeyPress(event) {
    // If modal is open, only allow Escape key to close it
    if (imageModal.style.display === 'flex') {
        if (event.key === 'Escape') {
            imageModal.style.display = 'none';
        }
        return; // Ignore other keys when modal is open
    }

    if (currentClassificatonImageIndex >= classificationImages.length) return;

    if (event.key === 'ArrowRight') {
        classify('Так');
    } else if (event.key === 'ArrowLeft') {
        classify('Ні');
    } else if (event.key === 'ArrowDown') {
        classify('Проблематично визначити');
    }
}

async function classify(classification) {
    if (currentClassificatonImageIndex >= classificationImages.length) {
        const errorMsg = 'Classification index out of bounds';
        console.error(errorMsg);
        alert(errorMsg);
        return;
    }

    const filename = classificationImages[currentClassificatonImageIndex];

    try {
        const star = await db.get('stars', filename);
        if (!star) {
            const errorMsg = `Star not found in database: ${filename}`;
            console.error(errorMsg);
            alert(errorMsg);
            return;
        }

        star.classification = classification;
        await db.put('stars', star);
    } catch (error) {
        const errorMsg = `Failed to save classification: ${error.message}`;
        console.error(errorMsg, error);
        alert(errorMsg);
        return;
    }

    currentClassificatonImageIndex++;
    await saveState();
    displayCurrentClassificationImage();
}

async function goBack() {
    if (currentClassificatonImageIndex > 0) {
        currentClassificatonImageIndex--;
        const filename = classificationImages[currentClassificatonImageIndex];

        // Set classification back to null in stars store
        try {
            const star = await db.get('stars', filename);
            if (star) {
                star.classification = null;
                await db.put('stars', star);
            }
        } catch (error) {
            console.error('Failed to update classification:', error);
        }

        await saveState();
        displayCurrentClassificationImage();
    }
}

function showCompletionScreen() {
    viewerSection.classList.add('d-none');
    resultsSection.classList.remove('d-none');
    renderFinalResultsTable();
    renderPaginationControls();
}

async function renderFinalResultsTable() {
    const offset = (currentPage - 1) * rowsPerPage;

    // Use cursor.advance() to efficiently paginate through stars
    const tx = db.transaction('stars', 'readonly');
    const starsStore = tx.objectStore('stars');
    const paginatedResults = [];

    let cursor = await starsStore.openCursor();

    // Advance to the offset position
    if (cursor && offset > 0) {
        cursor = await cursor.advance(offset);
    }

    // Collect rowsPerPage results
    let count = 0;
    while (cursor && count < rowsPerPage) {
        const star = cursor.value;
        paginatedResults.push({
            starId: star.ticId,
            filename: star.fileName,
            classification: star.classification,
            imageUrl: null
        });
        count++;
        cursor = await cursor.continue();
    }

    // Render the results
    const currentRows = resultsTableBody.children.length;
    const neededRows = paginatedResults.length;

    if (currentRows !== neededRows) {
        resultsTableBody.innerHTML = '';

        for (let index = 0; index < paginatedResults.length; index++) {
            const result = paginatedResults[index];
            const resultIndex = offset + index;
            const row = await createResultRow(result, resultIndex);
            resultsTableBody.appendChild(row);
        }
    } else {
        // Update existing rows
        Array.from(resultsTableBody.children).forEach((row, index) => {
            if (index < paginatedResults.length) {
                updateResultRow(row, paginatedResults[index], offset + index);
            }
        });
    }
}

async function createResultRow(result, resultIndex) {
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
        
        // Immediately update the cell background color
        const cell = event.target.closest('td');
        const classificationClass = getClassificationClass(newClassification);
        cell.className = '';
        cell.classList.add(classificationClass);
        
        updateClassification(indexToUpdate, newClassification);
    });

    const classificationClass = getClassificationClass(result.classification);
    const classificationCell = document.createElement('td');
    classificationCell.classList.add(classificationClass);
    classificationCell.appendChild(select);

    const previewCell = document.createElement('td');
    // Create image element and load from IndexedDB
    const img = document.createElement('img');
    img.className = 'preview-image img-thumbnail';
    img.alt = result.filename;
    img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iI2RkZCIvPgo8dGV4dCB4PSI1MCUiIHk9IjUwJSIgZHk9Ii4zZW0iIGZpbGw9IiM5OTkiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5Завантаження...</dGV4dD4KPHN2Zz4='; // placeholder SVG
    
    // Load actual image from IndexedDB
    loadImageForPreview(img, result.filename);
    
    previewCell.appendChild(img);

    const filenameCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = `https://simbad.cds.unistra.fr/simbad/sim-basic?Ident=TIC+${result.starId}&submit=SIMBAD+search`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerText = result.starId;
    filenameCell.appendChild(link);

    row.appendChild(previewCell);
    row.appendChild(classificationCell);
    row.appendChild(filenameCell);
    
    return row;
}

async function loadImageForPreview(imgElement, filename) {
    try {
        const blob = await getImageBlobFromDB(filename);
        if (blob) {
            const url = URL.createObjectURL(blob);
            imgElement.src = url;
            // Clean up URL when image is removed from DOM (optional optimization)
            imgElement.addEventListener('load', () => {
                // Store URL for later cleanup if needed
                imgElement.dataset.objectUrl = url;
            });
        }
    } catch (error) {
        console.error('Failed to load preview image:', error);
        imgElement.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iI2Y4ZDdkYSIvPgo8dGV4dCB4PSI1MCUiIHk9IjUwJSIgZHk9Ii4zZW0iIGZpbGw9IiM3MjE5MjEiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXNpemU9IjEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5Помилка</dGV4dD4KPHN2Zz4='; // error SVG
    }
}

function updateResultRow(row, result, resultIndex) {
    const cells = row.children;
    
    // Update preview image
    const img = cells[0].querySelector('img');
    if (img.alt !== result.filename) {
        img.alt = result.filename;
        // Load new image from IndexedDB
        loadImageForPreview(img, result.filename);
    }
    
    // Update classification
    const select = cells[1].querySelector('select');
    if (select.value !== result.classification) {
        select.value = result.classification;
        select.dataset.resultIndex = resultIndex;
    }
    
    // Always update classification class to ensure it's correct
    const classificationClass = getClassificationClass(result.classification);
    cells[1].className = '';
    cells[1].classList.add(classificationClass);
    
    // Update star ID and link
    const link = cells[2].querySelector('a');
    if (link) {
        if (link.innerText !== result.starId) {
            link.innerText = result.starId;
            link.href = `https://simbad.cds.unistra.fr/simbad/sim-basic?Ident=TIC+${result.starId}&submit=SIMBAD+search`;
        }
    } else {
        // Create link if it doesn't exist
        cells[2].innerHTML = '';
        const newLink = document.createElement('a');
        newLink.href = `https://simbad.cds.unistra.fr/simbad/sim-basic?Ident=TIC+${result.starId}&submit=SIMBAD+search`;
        newLink.target = '_blank';
        newLink.rel = 'noopener noreferrer';
        newLink.innerText = result.starId;
        cells[2].appendChild(newLink);
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

    // Update only classification field in stars store
    const result = results[index];
    try {
        const star = await db.get('stars', result.filename);
        if (star) {
            star.classification = newClassification;
            await db.put('stars', star);
        } else {
            const errorMsg = `Star not found in store: ${result.filename}`;
            console.error(errorMsg);
            alert(errorMsg);
        }
    } catch (error) {
        const errorMsg = `Failed to update classification: ${error.message}`;
        console.error(errorMsg, error);
        alert(errorMsg);
    }

    debouncedSaveState();
    renderFinalResultsTable();
}

function renderPaginationControls() {
    const pageCount = Math.ceil(totalStarsCount / rowsPerPage);
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
            renderFinalResultsTable();
            renderPaginationControls();
        }
    });

    li.appendChild(a);
    return li;
}

async function copyResultsToClipboard() {
    try {
        // Read all stars from database
        const tx = db.transaction('stars', 'readonly');
        const starsStore = tx.objectStore('stars');
        const allStars = await starsStore.getAll();

        // Create TSV format (Tab-Separated Values) for Excel
        const headers = "Номер TIC\tВідкривач\tЧи зоря змінна ?";
        const rows = allStars.map(star => {
            // If classification is null, write empty value in column
            const classification = star.classification || '';
            return `${star.ticId}\t\t${classification}`;
        });
        const tsvData = [headers, ...rows].join('\n');

        await navigator.clipboard.writeText(tsvData);
        copySuccessModal.show();
    } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        alert('Помилка копіювання в буфер обміну. Спробуйте ще раз.');
    }
}

async function downloadResults() {
    try {
        // Read all stars from database
        const tx = db.transaction('stars', 'readonly');
        const starsStore = tx.objectStore('stars');
        const allStars = await starsStore.getAll();

        const data = allStars.map(star => ({
            "Номер TIC": star.ticId,
            "Відкривач": "",
            "Чи зоря змінна ?": star.classification || ''
        }));

        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Результати");

        XLSX.writeFile(workbook, "classification_results.xls");
    } catch (error) {
        console.error('Failed to download results:', error);
        alert('Помилка завантаження результатів. Спробуйте ще раз.');
    }
}

function extractStarId(filename) {
    const match = filename.match(/TIC_(\d+)_/);
    return match ? match[1] : 'N/A';
}