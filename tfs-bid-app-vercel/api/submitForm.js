const { google } = require('googleapis');
const stream = require('stream');

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const NOTIFICATION_EMAILS = process.env.NOTIFICATION_EMAILS.split(',');
const SERVICE_EMAIL = "service@tristatefiresprinklers.com";

async function getAuth() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [
            '[https://www.googleapis.com/auth/spreadsheets](https://www.googleapis.com/auth/spreadsheets)',
            '[https://www.googleapis.com/auth/drive](https://www.googleapis.com/auth/drive)',
            '[https://www.googleapis.com/auth/gmail.send](https://www.googleapis.com/auth/gmail.send)'
        ],
    });
    return auth.getClient();
}

module.exports = async (req, res) => {
    try {
        const data = req.body;
        const auth = await getAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const drive = google.drive({ version: 'v3', auth });
        const gmail = google.gmail({ version: 'v1', auth });

        await updateJobTitles(sheets, data.contacts);
        const fileLinks = await handleFileUploads(drive, data.files, data.streetAddress, data.revisionNumber);
        await logSubmission(sheets, data, fileLinks.join(', '));
        await updateContactDirectories(sheets, data.companyName, data.contacts);
        await sendEmailNotification(gmail, data, fileLinks);

        res.status(200).json({ success: true, message: 'Submission successful!' });
    } catch (error) {
        console.error('Error in submitForm:', error);
        res.status(500).json({ success: false, message: 'Submission failed: ' + error.message });
    }
};

async function updateJobTitles(sheets, contacts) {
    const range = 'Job Titles!A2:A';
    const existingTitlesData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const existingTitles = existingTitlesData.data.values ? existingTitlesData.data.values.flat() : [];
    const newTitles = [];
    contacts.forEach(c => {
        if (c.title && !existingTitles.includes(c.title)) {
            newTitles.push([c.title]);
        }
    });
    if (newTitles.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Job Titles!A:A',
            valueInputOption: 'USER_ENTERED',
            resource: { values: newTitles },
        });
    }
}

async function handleFileUploads(drive, files, streetAddress, revisionNumber) {
    const uploadPromises = (files || []).map(async (file, index) => {
        const buffer = Buffer.from(file.content, 'base64');
        const bufferStream = new stream.PassThrough();
        bufferStream.end(buffer);
        const originalName = file.name;
        const extension = originalName.includes('.') ? '.' + originalName.split('.').pop() : '';
        const baseName = streetAddress.replace(/[/\\?%*:|"<>]/g, '-');
        const revisionPart = revisionNumber ? `_Rev${revisionNumber}` : '';
        const fileCounter = files.length > 1 ? `_(${index + 1})` : '';
        const newFileName = `${baseName}_SP${revisionPart}${fileCounter}${extension}`;

        const response = await drive.files.create({
            requestBody: {
                name: newFileName,
                parents: [DRIVE_FOLDER_ID],
            },
            media: {
                mimeType: file.mimeType,
                body: bufferStream,
            },
            fields: 'id, webViewLink',
        });
        return response.data.webViewLink;
    });
    return Promise.all(uploadPromises);
}

async function logSubmission(sheets, data, fileLinksString) {
    const newRow = [
        new Date(), data.streetAddress, data.city, data.state, "", data.jobType, data.companyName,
        data.contacts.map(c => c.name).join('; '), data.contacts.map(c => c.title).join('; '),
        data.contacts.map(c => c.emails.join(', ')).join('; '), data.contacts.map(c => c.phones.join(', ')).join('; '),
        fileLinksString, data.submitterName, data.isRevision ? 'Yes' : 'No', data.revisionNumber || '', data.comments || ''
    ];
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Form Responses!A:A',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [newRow] },
    });
}

async function updateContactDirectories(sheets, companyName, contacts) {
    const gcSheetRange = 'GC Directory!A2:B';
    const existingGcData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: gcSheetRange });
    const existingGcContacts = new Set((existingGcData.data.values || []).map(([company, contact]) => `${company}|${contact}`));

    const newGcRows = [];
    const newContactRows = [];
    contacts.forEach(c => {
        if (!c.name) return;
        newContactRows.push([companyName, c.name, c.title, c.phones.join(', '), c.emails.join(', ')]);
        const key = `${companyName}|${c.name}`;
        if (!existingGcContacts.has(key)) {
            newGcRows.push([companyName, c.name, c.title, c.emails.join(', '), c.phones.join(', ')]);
            existingGcContacts.add(key);
        }
    });

    if (newGcRows.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'GC Directory!A:A', valueInputOption: 'USER_ENTERED', resource: { values: newGcRows }
        });
    }
    if (newContactRows.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Contacts!A:A', valueInputOption: 'USER_ENTERED', resource: { values: newContactRows }
        });
    }
}

async function sendEmailNotification(gmail, data, fileLinks) {
    const recipients = [...new Set([...NOTIFICATION_EMAILS, data.submitterEmail])];
    if (data.jobType === 'Retro fit' || data.jobType === 'Service call') {
        recipients.push(SERVICE_EMAIL);
    }
    const subject = data.isRevision
        ? `${data.streetAddress} Revised bid revision #${data.revisionNumber}`
        : `${data.streetAddress} New bid`;
    const fullAddress = `${data.streetAddress}, ${data.city}, ${data.state}`;
    const htmlBody = `
        ${data.comments ? `<b>Comments:</b><br><div style="background-color:#f0f0f0; border:1px solid #ccc; padding:10px; margin-bottom:15px;">${data.comments.replace(/\n/g, '<br>')}</div>` : ''}
        <b>New Bid Submission</b><br><br>
        <b>Job Type:</b> ${data.jobType}<br><br>
        ${data.isRevision ? `<b>REVISION NUMBER:</b> ${data.revisionNumber}<br><br>` : ''}
        <b>Submitted by:</b> ${data.submitterName}<br>
        <b>Job Address:</b> ${fullAddress}<br>
        <b>Company Name:</b> ${data.companyName}<br><br>
        <b>Contacts:</b><br>
        ${data.contacts.map(c => `
            <u>${c.name}</u> (${c.title || 'N/A'})<br>
            Emails: ${c.emails.join(', ') || 'N/A'}<br>
            Phones: ${c.phones.join(', ') || 'N/A'}<br><br>
        `).join('')}
        <b>Files:</b><br>
        ${fileLinks.length > 0 ? fileLinks.map(l => `<a href="${l}" target="_blank">${l.split('/').pop()}</a>`).join('<br>') : 'None'}
    `;

    const emailLines = [
        "Content-Type: text/html; charset=utf-8",
        "MIME-Version: 1.0",
        `To: ${recipients.join(',')}`,
        `Reply-To: ${data.submitterEmail}`,
        `From: "${data.submitterName}" <${NOTIFICATION_EMAILS[0]}>`, // Use a verified sender email
        "Subject: " + subject,
        "",
        htmlBody
    ];
    const email = emailLines.join("\r\n");

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw: Buffer.from(email).toString('base64')
        }
    });
}

