# Teamly — User Manual

A guide to using Teamly after it's deployed and running. Covers all roles: employee, approver, and admin.

---

## Roles

| Role | What they can do |
|---|---|
| **Super Admin** | Full access — users, settings, all data, overrides, year-end reset |
| **HOD** | Approve sick leave, emergency leave, comp off, and WFH for their team |
| **Approver** | Approve annual leave (AL) and unpaid leave (UPL) for assigned employees; approve claims |
| **Employee** | Submit requests, view own history and balances, clock in/out |

A user can hold multiple roles (e.g. an HOD can also be an AL approver).

---

## First Login

New accounts are created by the admin with `force_password_reset` enabled. On first login:

1. Enter your username
2. You'll be prompted to set your own password (minimum 8 characters)
3. After setting it, you're taken straight to your dashboard

---

## Dashboard

The dashboard is tabbed. Tabs visible to you depend on your role.

| Tab | Who sees it |
|---|---|
| Overview | All |
| Clock | All |
| Leave | All |
| WFH | All |
| Claims | All |
| My History | All |
| Team Calendar | All |
| Approvals | HODs and approvers only |
| Account | All |

---

## Clock In / Out

Go to the **Clock** tab.

- Click **Clock IN** at the start of your day, **Clock OUT** at the end
- You can add an optional note and allow the browser to capture your GPS location
- You cannot clock IN twice in a row without clocking OUT first
- Your clock history is shown below the button

The admin configures the clock window (e.g. 9:00–10:00). If you clock IN after the window end time, your record will be flagged as **Late** in the admin view.

---

## Submitting Leave

Go to the **Leave** tab. Select a leave type from the dropdown:

### Annual Leave (AL)
- Pick a start date and end date; optionally mark a half day (AM or PM)
- You must submit at least **5 days in advance** (today counts as day 1)
- Your balance is shown in two buckets — carry-forward (Bucket A, expires 31 March) and current year (Bucket B); Bucket A is deducted first
- Dates marked as public holidays or blackout dates are disabled in the date picker
- Once approved, you can cancel the leave up to **3 days before the start date** — click **Cancel Leave** on the approved row, enter a reason, and confirm. Your balance is refunded automatically.

### Sick Leave
- No balance limit
- A medical certificate (MC) attachment is **required** — upload an image or PDF

### Emergency Leave / Comp Off
- No balance limit
- A reason is **required**

### Unpaid Leave (UPL)
- No balance limit
- You must submit at least **5 days in advance**

After submitting, the request appears in **My History** and an email is sent to your assigned approver.

---

## Submitting a WFH Request

Go to the **WFH** tab.

- Pick one or more dates to work from home
- A reason is required
- You must submit at least **24 hours in advance**
- Maximum **2 WFH days per Monday–Sunday week** — the system blocks you if you've reached the limit
- Your WFH requests (approved and pending) are visible to the whole team in the **Team Calendar**

---

## Submitting a Claim

Go to the **Claims** tab.

- Fill in the item description, amount, category, and department
- A receipt image is **required**
- After submission, your claims approver receives a notification email

Status flow: **Pending → Payment Pending → Paid**

You can cancel a pending claim from **My History** before it is acted on.

---

## My History

Go to the **My History** tab to see all your leave, WFH, and claim requests.

- Status badges are colour-coded: pending (yellow), approved (green), rejected (red), cancelled (grey)
- Rejected requests show the reason given by the approver
- Approved AL requests show a **Cancel Leave** button if the start date is more than 3 days away

---

## Team Calendar

Go to the **Team Calendar** tab to see a monthly view of approved and pending leave and WFH across your whole team.

- Navigate months with the previous/next arrows
- Sensitive details (reasons, attachments) are not shown — only employee name, department, and leave type

---

## Approvals (HODs and Approvers)

Go to the **Approvals** tab. You'll see two sections: pending leave and pending WFH.

**To approve or reject:**
1. Click **Approve** or **Reject** on any row
2. For rejections, enter a reason — this is recorded and visible to the employee in their history

You can also approve or reject via the **email links** sent when a request is submitted. Click Approve or Reject directly from the email — rejections will prompt you for a reason in the browser.

Claims are managed entirely from the Admin Console (see below).

---

## Account

Go to the **Account** tab to change your password.

- Enter your current password and a new password (minimum 8 characters)
- Super admin accounts manage their password via the `ADMIN_PASSWORD` environment variable, not through this tab

---

## Admin Console

Accessible to the super admin only. Navigate to `/admin.html` or use the Admin link after logging in as admin.

### Overview
- Live counts of pending leave, WFH, and claims
- Quick action buttons on every row
- Override button for any request

### Clock
- Set the clock-in window (start time and end time)
- **Who's IN** board — colour-coded cards showing all staff current status
- Searchable clock records table by name and/or date

### Users
- Add, edit, and delete user accounts
- Fields: name, username, email, password, role, department, timezone
- Assign three approvers per user: HOD (sick/emergency/WFH), AL approver (AL/UPL), claims approver
- **Force password reset** — user must set a new password on next login

### AL Balances
- View and edit annual leave balances per employee per year
- Columns: Carry-Forward A, Current Year B, Used A, Used B, Remaining
- Colour-coded: green (healthy), amber (≤3 days), red (0)

### Claims
- Full claims list with filter by status
- Action buttons: **Payment Pending**, **Mark Paid**, **Reject**, receipt viewer, Override

### Tracking
- Unified view of all leave, WFH, and claims in one filterable table
- Filters: employee, department, type, status, date range
- Click any row to expand full details
- Toggle to **Month view** (coloured pills per day) or **Week view** (employee rows × day columns)
- Override button available on every row

### Public Holidays
- Add single dates or ranges as public holidays with a name and region (MY, UK, or ALL)
- Public holidays are excluded from leave day counts based on the employee's timezone region
- Remove individual holidays or clear all at once

### Blackout Dates
- Add single dates or ranges as blackout periods with an optional reason
- Blackout dates are disabled in the leave submission date picker

### CSV Export
- Download any data table as a CSV file
- Available tables: Users, Leave Requests, WFH Requests, Claims, AL Balances, Clock Records
- File attachments (MC docs, receipts) are excluded from exports

### DB Reset
- Wipes all operational data: leave, WFH, claims, clock records, balances, counters
- Type `RESET` to confirm — use this at year-end after downloading your CSV exports

---

## Admin Override

The super admin can change the status of any request at any time, regardless of its current state.

- Click **Override** on any row in the Admin Console
- Select the new status and enter an optional reason
- For annual leave overrides, the balance is adjusted automatically
- The override reason is recorded in the request for traceability

---

## Email Notifications

| Event | Who receives it |
|---|---|
| Leave submitted | Assigned approver — with approve/reject links |
| WFH submitted | Assigned HOD — notification |
| Claim submitted | Claims approver — notification (no email action; manage in admin console) |
| Leave approved or rejected | Employee |
| WFH approved or rejected | Employee |
| Claim approved or rejected | Employee |
| First day of approved AL | HOD — day-of reminder at 8AM |
| Approved AL cancelled by employee | Original approver — notification |
