# QR Photo Share

Admin drops a photo → a QR code is made → guests scan it and get the framed photo on their phone.

## Run it
```bash
npm install
npm start
```

| Page | URL | Who uses it |
|---|---|---|
| Admin (drag & drop upload) | http://localhost:3001/admin | You / the operator |
| QR screen | http://localhost:3001/display | Big screen for guests — auto-updates every 3 s with the latest photo |
| Photo page | http://<your-ip>:3001/p/<id> | Opens on the guest's phone after scanning |

## Making the QR work on phones
The QR points at your computer's Wi-Fi IP, so **the phone must be on the same Wi-Fi**.
If it picks the wrong IP, or you deploy online, set it yourself:

```bash
BASE_URL=https://your-domain.com npm start
```

## Optional admin password
```bash
ADMIN_KEY=secret123 npm start
```
The admin page will then ask for the key before uploading or deleting.

Photos are stored in `uploads/`, and the list in `data.json`.
