# Lazada Order PDF Downloader

A Chrome extension that bulk downloads your Lazada (Thailand) order detail pages as PDF files. No more manually opening each order and printing one by one.

## Features

- **Bulk PDF Download** - Automatically opens each order detail page and saves it as a clean PDF
- **Date Range Filter** - Download orders from a specific period with quick buttons for full years
- **Status Filter** - Exclude cancelled or other unwanted order statuses
- **Clean PDFs** - Optionally remove ads, sidebar, and header from the PDF output
- **Fit to One Page** - Automatically scales the order to fit on a single PDF page
- **Smart Page Navigation** - Binary search jumps directly to the right page range instead of scanning every page
- **Auto-Navigate** - Click Start from any page; the extension navigates to your orders page automatically
- **Login Detection** - Detects if you need to log in and prompts you
- **Duplicate Prevention** - Ensures each order is only downloaded once
- **Date Validation** - Auto-detects and fixes inverted date ranges
- **Floating Button** - A convenient PDF button appears on your Lazada orders page

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the extension folder

## How to Use

1. **Open the extension** by clicking its icon in the Chrome toolbar (or the floating PDF button on Lazada)
2. **Set your date range** using the date pickers or quick buttons (Today, This Month, 2026, 2025, etc.)
3. **Configure options** (optional):
   - Open "PDF Options" to toggle ad removal, sidebar removal, header removal, and fit-to-page
   - Open "Status Filter" to exclude specific order statuses (Cancelled is excluded by default)
4. **Click "Start Downloading PDFs"**
5. The extension will:
   - Navigate to your Lazada orders page (if not already there)
   - Use binary search to jump to the right page range for your dates
   - Open each order detail in a background tab
   - Clean up the page and save it as PDF
   - Move to the next order automatically
6. **Monitor progress** - See downloaded count, pages processed, and skipped orders in real-time
7. **Click Stop** anytime to pause the process

## Where Are My PDFs?

PDFs are saved to your **Downloads** folder inside a **Lazada_Orders** subfolder:

```
Downloads/
  Lazada_Orders/
    2026-01-15_123456789_ShopName.pdf
    2026-01-14_987654321_AnotherShop.pdf
    ...
```

Files are named: `YYYY-MM-DD_OrderID_ShopName.pdf`

To find them:
- **Mac**: Open Finder > Downloads > Lazada_Orders
- **Windows**: Open File Explorer > Downloads > Lazada_Orders

## Permissions

This extension only requests permissions it needs:

| Permission | Why |
|---|---|
| `activeTab` | To read and interact with the current Lazada tab |
| `tabs` | To open order detail pages in background tabs |
| `scripting` | To extract order data and inject cleanup CSS |
| `debugger` | To use Chrome's print-to-PDF functionality |
| `downloads` | To save the generated PDF files |

Host permissions are limited to `https://my.lazada.co.th/*` only.

## Changelog

### v2.4
- **Rebuilt smart page navigation** - Binary search reliably finds the correct page range for any date filter
- **Fixed Go button navigation** - Uses `execCommand('insertText')` for reliable React input handling, with retry and fallback logic
- **Per-page early stopping** - Processes all orders on each page before deciding to stop, handling mixed-date pages correctly
- **Visual order extraction** - Orders are now sorted by their vertical position on the page to match Lazada's display order
- **Stale page detection** - Automatically reloads if the page is left over from a previous run
- **Date range validation** - Auto-swaps inverted date ranges instead of silently failing

### v2.3
- Side panel UI, beautiful logs, PDF layout fixes, and reliability improvements

### v2.0
- Major update with 16 improvements

### v1.0
- Initial release

## Tips

- **First run**: Make sure you're logged into Lazada before starting
- **Delay setting**: The default 500ms delay between orders keeps things smooth. Increase it if you encounter issues
- **Large batches**: For downloading many orders (hundreds+), consider doing it in yearly batches
- **Browser focus**: The extension works in the background but needs Chrome to stay open

## Troubleshooting

| Problem | Solution |
|---|---|
| "Found 0 orders" | Make sure you're on the Lazada My Orders page and orders are visible |
| Login redirect | Log into Lazada in the same browser, then try again |
| PDF looks wrong | Try toggling the PDF options (ads, sidebar, header removal) |
| Extension not loading | Go to `chrome://extensions/`, remove it, and load unpacked again |
| Wrong page after restart | The extension auto-detects stale pages and reloads — just run again |

## License

MIT License - Copyright (c) 2026 Daniel Rudaev @ D1DX
