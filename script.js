const dbName = 'ImageClassifierDB';
const dbVersion = 2;
let db;
let confirmationModal;
let copySuccessModal;

// State Management
let classificationImages = []; // Array of fileNames for unclassified images only
let currentClassificatonImageIndex = 0;
let totalStarsCount = 0; // Total number of stars in database for pagination
let classifiedCount = 0; // Number of classified images
let currentPage = 1;
let rowsPerPage = 10;
let currentClassificationImageUrl = null;
let saveStateTimeout = null;
let currentView = 'classifier'; // 'classifier' or 'results'
let currentFilter = 'all'; // Current classification filter
let filteredStarsCount = 0; // Count of stars after applying filter

// DOM Element References
const zipInput = document.getElementById('zip-input');
const uploadLabel = document.getElementById('upload-label');
const statusText = document.getElementById('status-text');
const displayImage = document.getElementById('display-image');

const uploadSection = document.getElementById('upload-section');
const viewerSection = document.getElementById('viewer-section');
const resultsSection = document.getElementById('results-section');
const navigationTabs = document.getElementById('navigation-tabs');
const classifierTab = document.getElementById('classifier-tab');
const resultsTab = document.getElementById('results-tab');
const classificationContent = document.getElementById('classification-content');
const allClassifiedMessage = document.getElementById('all-classified-message');
const yesBtn = document.getElementById('yes-btn');
const problematicBtn = document.getElementById('problematic-btn');
const noBtn = document.getElementById('no-btn');
const backBtn = document.getElementById('back-btn');
const uploadNewBtn = document.querySelector('.upload-new-btn');
const topCopyBtn = document.getElementById('top-copy-btn');
const topDownloadBtn = document.getElementById('top-download-btn');
const topImportBtn = document.getElementById('top-import-btn');
const resultsTableBody = document.querySelector('#results-table tbody');
const paginationControls = document.getElementById('pagination-controls');
const rowsPerPageSelect = document.getElementById('rows-per-page-select');
const classificationFilterSelect = document.getElementById('classification-filter-select');
const confirmationModalEl = document.getElementById('confirmationModal');
const confirmUploadBtn = document.getElementById('confirmUploadBtn');
const copySuccessModalEl = document.getElementById('copySuccessModal');
const importModalEl = document.getElementById('importModal');
const importTextarea = document.getElementById('import-textarea');
const confirmImportBtn = document.getElementById('confirmImportBtn');

// Image Modal Elements
const imageModal = document.getElementById('imageModal');
const modalImage = document.getElementById('modalImage');
const closeModal = document.querySelector('.close-modal');


// --- IndexedDB Functions ---

async function openDB() {
    return idb.openDB(dbName, dbVersion, {
        async upgrade(db, oldVersion, newVersion, transaction) {
            console.log(`Upgrading database from version ${oldVersion} to ${newVersion}`);

            // V1 schema - keep old object store for rollback
            if (oldVersion < 1) {
                db.createObjectStore('state');
            }

            // V2 schema - optimized structure
            if (oldVersion < 2) {
                console.log('Migrating data from V1 to V2...');

                // Create new V2 stores
                const imagesStore = db.createObjectStore('images', { keyPath: 'fileName' });
                const starsStore = db.createObjectStore('stars', { keyPath: 'fileName' });
                const appStateStore = db.createObjectStore('appState');

                // Get references to stores from the upgrade transaction
                const v1_stateStore = transaction.objectStore('state');

                // Migrate images from V1 'allImages' key
                const v1_allImages = await v1_stateStore.get('allImages');
                if (v1_allImages) {
                    console.log('Migrating images...');
                    const entries = Object.entries(v1_allImages);
                    console.log(`Found ${entries.length} images to migrate`);

                    for (const [fileName, blob] of entries) {
                        const fileNameOnly = fileName.split('/').pop();

                        // Add to images store
                        imagesStore.put({
                            fileName: fileNameOnly,
                            image: blob
                        });

                        // Create star record with ticId
                        const match = fileNameOnly.match(/TIC_(\d+)_/);
                        const ticId = match ? match[1] : 'N/A';
                        starsStore.put({
                            fileName: fileNameOnly,
                            ticId: ticId,
                            classification: null
                        });
                    }
                    console.log('Images and initial stars migrated.');
                }

                // Migrate app state from V1 'appState' key
                const v1_appState = await v1_stateStore.get('appState');
                if (v1_appState) {
                    console.log('Migrating app state...');

                    // Migrate pagination
                    appStateStore.put({ rowsPerPage: v1_appState.rowsPerPage || 10 }, 'pagination');

                    // Migrate classifications
                    if (v1_appState.results && Array.isArray(v1_appState.results)) {
                        console.log(`Migrating ${v1_appState.results.length} classifications`);
                        for (const v1_result of v1_appState.results) {
                            const fileNameOnly = v1_result.filename.split('/').pop();
                            const star = await starsStore.get(fileNameOnly);
                            if (star) {
                                star.classification = v1_result.classification;
                                starsStore.put(star);
                            }
                        }
                    }

                    console.log('App state migrated.');
                }

                console.log('Migration complete! V1 data preserved in "state" store for rollback.');
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

    await tx.done;
}

async function saveAllImagesToDB(zipImageEntries) {
    if (!db) return;

    try {
        console.log(`Saving all ${zipImageEntries.length} images to IndexedDB...`);

        // First, extract all blobs from zip
        const blobPromises = [];
        for (let i = 0; i < zipImageEntries.length; i++) {
            const imageEntry = zipImageEntries[i];
            if (imageEntry.zipEntry) {
                statusText.textContent = `Завантаження зображення: ${i + 1} з ${zipImageEntries.length}`;
                // Extract just the filename without path
                const fileName = imageEntry.name.split('/').pop();
                blobPromises.push(
                    imageEntry.zipEntry.async('blob').then(blob => ({
                        fileName: fileName,
                        blob: blob
                    }))
                );
            }
        }

        const blobData = await Promise.all(blobPromises);

        // Now save to IndexedDB in one transaction
        statusText.textContent = 'Збереження зображень в базу даних...';
        const tx = db.transaction(['images', 'stars'], 'readwrite');
        const imagesStore = tx.objectStore('images');
        const starsStore = tx.objectStore('stars');

        for (let i = 0; i < blobData.length; i++) {
            const { fileName, blob } = blobData[i];

            // Save image blob
            imagesStore.put({
                fileName: fileName,
                image: blob
            });

            // Create star record with null classification
            const starId = extractStarId(fileName);
            starsStore.put({
                fileName: fileName,
                ticId: starId,
                classification: null
            });
        }

        await tx.done;
        console.log(`Successfully saved ${blobData.length} images to IndexedDB`);

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
            totalStarsCount = allStars.length;
            filteredStarsCount = allStars.length; // Initialize for pagination

            // Build classificationImages from ONLY unclassified stars
            // This gets rebuilt on every page load with current unclassified images
            const unclassifiedStars = allStars.filter(star => star.classification === null);
            classificationImages = unclassifiedStars.map(star => star.fileName);

            // Count classified stars
            classifiedCount = allStars.filter(star => star.classification !== null).length;

            // Always start from the beginning after page reload
            currentClassificatonImageIndex = 0;

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

classificationFilterSelect.addEventListener('change', async () => {
    currentFilter = classificationFilterSelect.value;
    currentPage = 1; // Reset to first page when filter changes
    await renderFinalResultsTable();
    renderPaginationControls();
});

// Navigation tab listeners
classifierTab.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('classifier');
    updateURL('classifier');
});

resultsTab.addEventListener('click', (e) => {
    e.preventDefault();
    switchView('results');
    updateURL('results');
});

// Handle browser back/forward buttons
window.addEventListener('popstate', (event) => {
    if (event.state && event.state.view) {
        switchView(event.state.view);
    } else if (classificationImages.length > 0) {
        // Default to classifier view if data is loaded
        switchView('classifier');
    }
});

function updateURL(view) {
    const url = new URL(window.location);
    if (view === 'classifier') {
        url.searchParams.set('view', 'classificator');
    } else {
        url.searchParams.set('view', view);
    }
    window.history.pushState({ view }, '', url);
}

function getViewFromURL() {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get('view');
    // Support both 'classificator' and 'classifier' in URL
    if (viewParam === 'classificator' || viewParam === 'classifier') {
        return 'classifier';
    }
    return viewParam;
}

function getDefaultView() {
    // If no view in URL, determine default based on classification state
    const params = new URLSearchParams(window.location.search);
    if (!params.has('view')) {
        // Check if all images are classified
        if (currentClassificatonImageIndex >= classificationImages.length && classificationImages.length > 0) {
            return 'results';
        }
        return 'classifier';
    }
    return getViewFromURL();
}

function switchView(view) {
    currentView = view;

    if (view === 'classifier') {
        classifierTab.classList.add('active');
        resultsTab.classList.remove('active');
        viewerSection.classList.remove('d-none');
        resultsSection.classList.add('d-none');

        // Show appropriate content in classifier view
        if (currentClassificatonImageIndex < classificationImages.length) {
            classificationContent.classList.remove('d-none');
            allClassifiedMessage.classList.add('d-none');
            displayCurrentClassificationImage();
        } else {
            classificationContent.classList.add('d-none');
            allClassifiedMessage.classList.remove('d-none');
        }
    } else if (view === 'results') {
        classifierTab.classList.remove('active');
        resultsTab.classList.add('active');
        viewerSection.classList.add('d-none');
        resultsSection.classList.remove('d-none');
        renderFinalResultsTable();
        renderPaginationControls();
    }
}

async function init() {
    confirmationModal = new bootstrap.Modal(confirmationModalEl);
    copySuccessModal = new bootstrap.Modal(copySuccessModalEl);
    const importModal = new bootstrap.Modal(importModalEl);

    // Import button opens modal
    topImportBtn.addEventListener('click', () => {
        importTextarea.value = ''; // Clear textarea
        importModal.show();
    });

    // Confirm import button processes the data
    confirmImportBtn.addEventListener('click', async () => {
        await importResultsFromTextarea();
        importModal.hide();
    });

    confirmUploadBtn.addEventListener('click', async () => {
        await clearCurrentData();

        resultsSection.classList.add('d-none');
        viewerSection.classList.add('d-none');
        navigationTabs.classList.add('d-none');
        uploadNewBtn.classList.add('d-none');
        topCopyBtn.classList.add('d-none');
        topDownloadBtn.classList.add('d-none');
        topImportBtn.classList.add('d-none');
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
        topImportBtn.classList.remove('d-none');
        navigationTabs.classList.remove('d-none');

        // Check URL for initial view, or determine based on classification state
        const initialView = getDefaultView();
        switchView(initialView);
        updateURL(initialView);
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
                topCopyBtn.classList.remove('d-none');
                topDownloadBtn.classList.remove('d-none');
                topImportBtn.classList.remove('d-none');
                navigationTabs.classList.remove('d-none');

                // Save all images to IndexedDB
                await saveAllImagesToDB(zipImageEntries);

                // Try to restore previous state for this ZIP file
                const stateRestored = await loadState();
                await saveState();

                // Check URL for initial view, or determine based on classification state
                await new Promise(resolve => setTimeout(resolve, 500));
                const initialView = getDefaultView();
                switchView(initialView);
                updateURL(initialView);
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
            statusText.textContent = `Класифіковано ${classifiedCount} зображень з ${totalStarsCount} | TIC ${starId}`;

            // Get image from IndexedDB
            const blob = await getImageBlobFromDB(fileName);

            if (blob) {
                currentClassificationImageUrl = URL.createObjectURL(blob);
                displayImage.src = currentClassificationImageUrl;
                statusText.textContent = `Класифіковано ${classifiedCount} зображень з ${totalStarsCount} | TIC ${starId}`;
            } else {
                const errorMsg = `Image not found in database: ${fileName}`;
                console.error(errorMsg);
                alert(errorMsg);
            }
        } catch (error) {
            const errorMsg = `Error loading image: ${error.message}`;
            console.error(errorMsg, error);
            alert(errorMsg);
            statusText.textContent = `Помилка завантаження зображення`;
        }
    } else {
        // All images classified, show completion message in classifier view
        classificationContent.classList.add('d-none');
        allClassifiedMessage.classList.remove('d-none');
    }
    // Enable back button only if we're not at the start
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

        // Update counts
        classifiedCount++;

        // Move to next image
        currentClassificatonImageIndex++;

        // Check if all images are now classified
        if (currentClassificatonImageIndex >= classificationImages.length) {
            // All unclassified images have been classified, redirect to results
            await saveState();

            // Reset filter to default (all)
            currentFilter = 'all';
            classificationFilterSelect.value = 'all';

            switchView('results');
            updateURL('results');
            return;
        }
    } catch (error) {
        const errorMsg = `Failed to save classification: ${error.message}`;
        console.error(errorMsg, error);
        alert(errorMsg);
        return;
    }

    await saveState();
    displayCurrentClassificationImage();
}

async function goBack() {
    // We can only go back if we're not at the start
    if (currentClassificatonImageIndex === 0) return;

    try {
        // Move back one image
        currentClassificatonImageIndex--;
        const filename = classificationImages[currentClassificatonImageIndex];

        // Unclassify the current image
        const star = await db.get('stars', filename);
        if (star && star.classification !== null) {
            star.classification = null;
            await db.put('stars', star);

            // Update counts
            classifiedCount--;
        }

        // If we were showing the completion message, hide it and show classification content
        if (allClassifiedMessage.classList.contains('d-none') === false) {
            allClassifiedMessage.classList.add('d-none');
            classificationContent.classList.remove('d-none');
        }

        await saveState();
        displayCurrentClassificationImage();
    } catch (error) {
        console.error('Failed to go back:', error);
    }
}

async function renderFinalResultsTable() {
    // Fetch all stars from database
    const tx = db.transaction('stars', 'readonly');
    const starsStore = tx.objectStore('stars');
    const allStars = await starsStore.getAll();

    // Apply filter
    let filteredStars = allStars;
    if (currentFilter !== 'all') {
        if (currentFilter === 'null') {
            // Filter for unclassified stars (null)
            filteredStars = allStars.filter(star => star.classification === null);
        } else {
            // Filter for specific classification
            filteredStars = allStars.filter(star => star.classification === currentFilter);
        }
    }

    // Calculate pagination based on filtered results
    filteredStarsCount = filteredStars.length;
    const offset = (currentPage - 1) * rowsPerPage;
    const paginatedStars = filteredStars.slice(offset, offset + rowsPerPage);

    // Convert to results format
    const paginatedResults = paginatedStars.map(star => ({
        starId: star.ticId,
        filename: star.fileName,
        classification: star.classification,
        imageUrl: null
    }));

    // Render the results
    const currentRows = resultsTableBody.children.length;
    const neededRows = paginatedResults.length;

    if (currentRows !== neededRows) {
        resultsTableBody.innerHTML = '';

        for (let index = 0; index < paginatedResults.length; index++) {
            const result = paginatedResults[index];
            const row = await createResultRow(result);
            resultsTableBody.appendChild(row);
        }
    } else {
        // Update existing rows
        Array.from(resultsTableBody.children).forEach((row, index) => {
            if (index < paginatedResults.length) {
                updateResultRow(row, paginatedResults[index]);
            }
        });
    }
}

async function createResultRow(result) {
    const row = document.createElement('tr');

    const classificationOptions = ['', 'Так', 'Ні', 'Проблематично визначити'];
    const select = document.createElement('select');
    select.classList.add('form-select');
    select.dataset.fileName = result.filename;

    classificationOptions.forEach(option => {
        const optionElement = document.createElement('option');
        optionElement.value = option;
        optionElement.innerText = option || '-';
        if (option === (result.classification || '')) {
            optionElement.selected = true;
        }
        select.appendChild(optionElement);
    });

    select.addEventListener('change', (event) => {
        const newClassification = event.target.value || null;
        const fileName = event.target.dataset.fileName;

        // Immediately update the cell background color
        const cell = event.target.closest('td');
        const classificationClass = getClassificationClass(newClassification);
        cell.className = '';
        if (classificationClass) {
            cell.classList.add(classificationClass);
        }

        updateClassification(fileName, newClassification);
    });

    const classificationClass = getClassificationClass(result.classification);
    const classificationCell = document.createElement('td');
    if (classificationClass) {
        classificationCell.classList.add(classificationClass);
    }
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

function updateResultRow(row, result) {
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
    if (select.value !== (result.classification || '')) {
        select.value = result.classification || '';
        select.dataset.fileName = result.filename;
    }

    // Always update classification class to ensure it's correct
    const classificationClass = getClassificationClass(result.classification);
    cells[1].className = '';
    if (classificationClass) {
        cells[1].classList.add(classificationClass);
    }
    
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

async function updateClassification(fileName, newClassification) {
    try {
        const star = await db.get('stars', fileName);
        if (star) {
            const previousClassification = star.classification;
            star.classification = newClassification;
            await db.put('stars', star);

            // Only reload if classification changed to/from null
            if (previousClassification === null || newClassification === null) {
                // Reload classificationImages from storage
                const tx = db.transaction('stars', 'readonly');
                const starsStore = tx.objectStore('stars');
                const allStars = await starsStore.getAll();

                // Rebuild classificationImages with unclassified stars
                const unclassifiedStars = allStars.filter(star => star.classification === null);
                classificationImages = unclassifiedStars.map(star => star.fileName);

                // Update classified count
                classifiedCount = allStars.filter(star => star.classification !== null).length;

                // Reset index to start
                currentClassificatonImageIndex = 0;
            }
        } else {
            const errorMsg = `Star not found in store: ${fileName}`;
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
    // Use filtered count instead of total count
    const pageCount = Math.ceil(filteredStarsCount / rowsPerPage);

    // Always rebuild pagination to ensure correct number of buttons
    paginationControls.innerHTML = '';

    if (pageCount > 0) {
        const fragment = document.createDocumentFragment();
        for (let i = 1; i <= pageCount; i++) {
            const li = createPaginationItem(i);
            fragment.appendChild(li);
        }
        paginationControls.appendChild(fragment);
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

        // Filter only stars with classification "Так" or "Проблематично визначити"
        const filteredStars = allStars.filter(star =>
            star.classification === 'Так' || star.classification === 'Проблематично визначити'
        );

        // Create TSV format (Tab-Separated Values) for Excel
        const headers = "Номер TIC\tВідкривач\tЧи зоря змінна ?";
        const rows = filteredStars.map(star => {
            return `${star.ticId}\t\t${star.classification}`;
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

        // Filter only stars with classification "Так" or "Проблематично визначити"
        const filteredStars = allStars.filter(star =>
            star.classification === 'Так' || star.classification === 'Проблематично визначити'
        );

        const data = filteredStars.map(star => ({
            "Номер TIC": star.ticId,
            "Відкривач": "",
            "Чи зоря змінна ?": star.classification
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

async function importResultsFromTextarea() {
    try {
        // Read textarea content
        const textareaContent = importTextarea.value;

        if (!textareaContent || textareaContent.trim() === '') {
            alert('Поле порожнє. Вставте таблицю результатів перед імпортом.');
            return;
        }

        // Parse TSV data (Tab-Separated Values)
        const lines = textareaContent.trim().split('\n');

        if (lines.length < 2) {
            alert('Некоректний формат даних. Таблиця повинна містити заголовки та хоча б один рядок даних.');
            return;
        }

        // Skip header row and parse data rows
        const importData = [];
        for (let i = 1; i < lines.length; i++) {
            const columns = lines[i].split('\t');

            if (columns.length >= 3) {
                const ticId = columns[0].trim();
                const classification = columns[2].trim();

                if (ticId && classification) {
                    importData.push({ ticId, classification });
                }
            }
        }

        if (importData.length === 0) {
            alert('Не знайдено даних для імпорту. Переконайтеся, що таблиця містить номери TIC та класифікації.');
            return;
        }

        // Get all stars from database to validate
        const tx = db.transaction('stars', 'readonly');
        const starsStore = tx.objectStore('stars');
        const allStars = await starsStore.getAll();

        // Create a set of valid ticIds for quick lookup
        const validTicIds = new Set(allStars.map(star => star.ticId));

        // Validate that all ticIds from clipboard exist in our database
        const invalidTicIds = [];

        for (const item of importData) {
            if (!validTicIds.has(item.ticId)) {
                invalidTicIds.push(item.ticId);
            }
        }

        if (invalidTicIds.length > 0) {
            alert(
                `Помилка імпорту!\n\n` +
                `Знайдено ${invalidTicIds.length} номерів TIC, які відсутні в базі даних:\n` +
                `${invalidTicIds.slice(0, 10).join(', ')}${invalidTicIds.length > 10 ? '...' : ''}\n\n` +
                `Переконайтеся, що ви імпортуєте таблицю для правильного набору зірок.`
            );
            return;
        }

        // Confirm import
        const confirmImport = confirm(
            `Імпортувати ${importData.length} класифікацій?\n\n` +
            `Всі інші зірки будуть класифіковані як "Ні".`
        );

        if (!confirmImport) {
            return;
        }

        // Create a map of ticId to classification for quick lookup
        const ticIdToClassification = new Map();
        for (const item of importData) {
            ticIdToClassification.set(item.ticId, item.classification);
        }

        // Perform update in transaction
        const updateTx = db.transaction('stars', 'readwrite');
        const updateStarsStore = updateTx.objectStore('stars');

        // Update all stars: set from imported data or set to "Ні"
        for (const star of allStars) {
            if (ticIdToClassification.has(star.ticId)) {
                star.classification = ticIdToClassification.get(star.ticId);
            } else {
                star.classification = 'Ні';
            }
            await updateStarsStore.put(star);
        }

        await updateTx.done;

        // Reload state and update UI
        await loadState();
        await saveState();

        // Refresh the results table
        renderFinalResultsTable();
        renderPaginationControls();

        alert(`Імпорт завершено!\n\nОновлено ${importData.length} класифікацій.\nРешта зірок класифіковано як "Ні".`);

    } catch (error) {
        console.error('Failed to import from textarea:', error);
        alert('Помилка імпорту. Спробуйте ще раз.\n\nДеталі: ' + error.message);
    }
}

function extractStarId(filename) {
    const match = filename.match(/TIC_(\d+)_/);
    return match ? match[1] : 'N/A';
}