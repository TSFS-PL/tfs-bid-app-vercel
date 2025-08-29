const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

async function getAuth() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['[https://www.googleapis.com/auth/spreadsheets.readonly](https://www.googleapis.com/auth/spreadsheets.readonly)'],
    });
    return await auth.getClient();
}

async function getSheetData(sheets, range) {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
    });
    return response.data.values || [];
}

async function getSubmitterList(sheets) {
    const rows = await getSheetData(sheets, 'Submitters!A2:B');
    return rows.map(([name, email]) => ({ name, email }));
}

async function getJobTitleList(sheets) {
    const rows = await getSheetData(sheets, 'Job Titles!A2:A');
    return rows.flat();
}

async function getCompanyList(sheets) {
    const rows = await getSheetData(sheets, 'GC Directory!A2:E');
    const companyData = {};
    rows.forEach(([company, contact, title, email, phone]) => {
        if (!company) return;
        if (!companyData[company]) {
            companyData[company] = [];
        }
        companyData[company].push({ name: contact || '', title: title || '', email: email || '', phone: phone || '' });
    });
    return companyData;
}

module.exports = async (req, res) => {
    try {
        const auth = await getAuth();
        const sheets = google.sheets({ version: 'v4', auth });

        const [submitters, jobTitles, companies] = await Promise.all([
            getSubmitterList(sheets),
            getJobTitleList(sheets),
            getCompanyList(sheets)
        ]);
        
        const data = {
            submitters,
            jobTitles,
            companies
        };
        
        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('Error in getData:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch initial data: ' + error.message });
    }
};
