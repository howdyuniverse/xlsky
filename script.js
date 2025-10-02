const dbName = 'ImageClassifierDB';
const dbVersion = 1;
let db;
let confirmationModal;

// State Management
let imageFiles = [];
let currentIndex = 0;
let results = [];
let currentPage = 1;
let rowsPerPage = 10;

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
    await db.put('state', { imageFiles, currentIndex, results, rowsPerPage }, 'appState');
}

async function loadState() {
    if (!db) return;
    const savedState = await db.get('state', 'appState');
    if (savedState) {
        imageFiles = savedState.imageFiles;
        currentIndex = savedState.currentIndex;
        results = savedState.results;
        if (savedState.rowsPerPage) {
            rowsPerPage = savedState.rowsPerPage;
            rowsPerPageSelect.value = savedState.rowsPerPage;
        }
        return true;
    }
    return false;
}

async function clearCurrentData() {
    imageFiles = [];
    currentIndex = 0;
    results = [];
    currentPage = 1;
    rowsPerPage = 10;
    if (db) {
        await db.clear('state');
    }
}

function uploadNewFileHandler() {
    confirmationModal.show();
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', init);
zipInput.addEventListener('change', handleFileSelect);
uploadLabel.addEventListener('click', () => zipInput.click());
document.addEventListener('keydown', handleKeyPress);
yesBtn.addEventListener('click', () => classify('Так'));
problematicBtn.addEventListener('click', () => classify('Проблематично визначити'));
noBtn.addEventListener('click', () => classify('Ні'));
backBtn.addEventListener('click', goBack);
uploadNewBtn.addEventListener('click', uploadNewFileHandler);
topDownloadBtn.addEventListener('click', downloadResults);

rowsPerPageSelect.addEventListener('change', async () => {
    rowsPerPage = parseInt(rowsPerPageSelect.value, 10);
    currentPage = 1;
    await saveState();
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
        topDownloadBtn.disabled = true;
        uploadSection.classList.remove('d-none');

        confirmationModal.hide();
    });

    db = await openDB();
    if (await loadState()) {
        uploadSection.classList.add('d-none');
        uploadNewBtn.classList.remove('d-none');
        topDownloadBtn.disabled = results.length === 0;

        if (currentIndex < imageFiles.length) {
            viewerSection.classList.remove('d-none');
            displayCurrentImage();
        } else {
            resultsSection.classList.remove('d-none');
            showCompletionScreen();
        }
    }
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    await clearCurrentData();

    statusText.textContent = 'Завантаження...';
    viewerSection.classList.remove('d-none');

    const zip = await JSZip.loadAsync(file);
    
    let allPngZipEntries = [];
    zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.png')) {
            allPngZipEntries.push(zipEntry);
        }
    });

    if (allPngZipEntries.length > 0) {
        let minDepth = -1;
        for (const entry of allPngZipEntries) {
            const depth = (entry.name.split('/').length - 1);
            if (minDepth === -1 || depth < minDepth) {
                minDepth = depth;
            }
        }
        
        const finalZipEntries = allPngZipEntries.filter(entry => (entry.name.split('/').length - 1) === minDepth);

        imageFiles = await Promise.all(finalZipEntries.map(async (entry) => {
            const blob = await entry.async('blob');
            return {
                name: entry.name,
                blob: blob,
            };
        }));
    }

    if (imageFiles.length > 0) {
        uploadSection.classList.add('d-none');
        uploadNewBtn.classList.remove('d-none');
        topDownloadBtn.disabled = true;
        await saveState();
        displayCurrentImage();
    } else {
        statusText.textContent = 'У ZIP-файлі не знайдено зображень PNG на першому рівні.';
    }
}

async function displayCurrentImage() {
    if (currentIndex < imageFiles.length) {
        const imageFile = imageFiles[currentIndex];
        const starId = extractStarId(imageFile.name);
        const imageUrl = URL.createObjectURL(imageFile.blob);
        
        displayImage.src = imageUrl;
        statusText.textContent = `Зображення ${currentIndex + 1} з ${imageFiles.length} | TIC ${starId}`;
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
    const imageUrl = displayImage.src;

    results.push({
        starId: starId,
        filename: filename,
        classification: classification,
        imageUrl: imageUrl
    });

    currentIndex++;
    topDownloadBtn.disabled = false;
    await saveState();
    displayCurrentImage();
}

async function goBack() {
    if (currentIndex > 0) {
        const lastResult = results.pop();
        URL.revokeObjectURL(lastResult.imageUrl);
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
    resultsTableBody.innerHTML = '';
    const start = (currentPage - 1) * rowsPerPage;
    const end = start + rowsPerPage;
    const paginatedResults = results.slice(start, end);

    paginatedResults.forEach((result, index) => {
        const resultIndex = start + index;
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

        let classificationClass = '';
        switch (result.classification) {
            case 'Так': classificationClass = 'classification-yes'; break;
            case 'Ні': classificationClass = 'classification-no'; break;
            case 'Проблематично визначити': classificationClass = 'classification-problematic'; break;
        }

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
        resultsTableBody.appendChild(row);
    });
}

async function updateClassification(index, newClassification) {
    results[index].classification = newClassification;
    await saveState();
    renderResultsTable();
}

function renderPaginationControls() {
    paginationControls.innerHTML = '';
    const pageCount = Math.ceil(results.length / rowsPerPage);

    for (let i = 1; i <= pageCount; i++) {
        const li = document.createElement('li');
        li.classList.add('page-item');
        if (i === currentPage) li.classList.add('active');

        const a = document.createElement('a');
        a.classList.add('page-link');
        a.href = '#';
        a.innerText = i;
        a.addEventListener('click', (e) => {
            e.preventDefault();
            currentPage = i;
            renderResultsTable();
            renderPaginationControls();
        });

        li.appendChild(a);
        paginationControls.appendChild(li);
    }
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