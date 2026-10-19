import os
import sqlite3
import secrets
from datetime import date
from functools import wraps

from flask import (
    Flask,
    request,
    redirect,
    url_for,
    session,
    flash,
    render_template_string,
    jsonify
)
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

DATABASE = os.environ.get("DATABASE_PATH", "fubs_online_banking.db")


def get_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def create_database():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                phone TEXT NOT NULL,
                nin_hash TEXT NOT NULL,
                balance REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                transaction_type TEXT NOT NULL,
                amount REAL NOT NULL,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        """)


def login_required(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return function(*args, **kwargs)
    return wrapper


STYLE = """
<style>
* { box-sizing: border-box; }
:root {
    --bg: #080d18;
    --panel: #111b2d;
    --text: #f5f8ff;
    --muted: #a8b6cd;
    --blue: #1685ff;
    --cyan: #35c5ff;
    --border: #30415e;
}
body.light {
    --bg: #f2f6ff;
    --panel: #ffffff;
    --text: #15233a;
    --muted: #66758e;
    --border: #d9e3f3;
}
body {
    margin: 0;
    padding: 20px;
    background: var(--bg);
    color: var(--text);
    font-family: Arial, sans-serif;
}
.container {
    max-width: 760px;
    margin: 25px auto;
}
.box {
    max-width: 460px;
    margin: 30px auto;
    background: var(--panel);
    padding: 28px;
    border-radius: 20px;
    border: 1px solid var(--border);
}
h1 { color: var(--cyan); }
p { color: var(--muted); line-height: 1.6; }
label { display: block; margin-top: 16px; }
input {
    width: 100%;
    padding: 13px;
    margin-top: 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
}
button, .button {
    display: inline-block;
    padding: 12px 16px;
    margin-top: 15px;
    border: none;
    border-radius: 10px;
    background: var(--blue);
    color: white;
    cursor: pointer;
    text-decoration: none;
    font-weight: bold;
}
form button { width: 100%; }
.panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 20px;
    margin: 15px 0;
}
.balance {
    background: linear-gradient(120deg, #1259d7, #078fca);
    color: white;
    border-radius: 20px;
    padding: 25px;
}
.balance h2 { font-size: 32px; }
.grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
}
.message {
    padding: 12px;
    margin: 12px 0;
    border-radius: 10px;
    background: #263750;
    overflow-wrap: anywhere;
}
.warning { font-size: 12px; }
.transaction {
    border-bottom: 1px solid var(--border);
    padding: 12px 0;
    overflow-wrap: anywhere;
}
a { color: var(--cyan); }
@media (max-width: 480px) {
    body { padding: 10px; }
    .box { padding: 20px; }
    .grid { grid-template-columns: 1fr; }
}
</style>
"""


REGISTER_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>Create Account - Fubs Online Banking</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    {{ style|safe }}
</head>
<body>
<div class="box">
    <h1>Fubs Online Banking</h1>
    <h2>Create Your Account</h2>
    <p>Register for your personal demo account.</p>

    {% for message in get_flashed_messages() %}
        <div class="message">{{ message }}</div>
    {% endfor %}

    <form method="POST">
        <label>Full Name</label>
        <input name="full_name" maxlength="100"
               placeholder="Enter your name" required>

        <label>Test NIN (11 digits only)</label>
        <input name="nin" inputmode="numeric"
               pattern="[0-9]{11}" maxlength="11"
               placeholder="Use a fictional test number" required>

        <label>Phone Number</label>
        <input name="phone" type="tel" maxlength="20"
               placeholder="Enter a test phone number" required>

        <label>Email Address</label>
        <input name="email" type="email" maxlength="254"
               placeholder="example@gmail.com" required>

        <label>Create Password (at least 8 characters)</label>
        <input name="password" type="password" minlength="8"
               autocomplete="new-password" required>

        <button type="submit">Create Account</button>
    </form>

    <p class="warning">
        Demo only. Do not enter your real NIN, banking details,
        or a password you use on another website.
        Identity is not verified.
    </p>

    <p>Already registered? <a href="{{ url_for('login') }}">Log in</a></p>
</div>
</body>
</html>
"""


LOGIN_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>Login - Fubs Online Banking</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    {{ style|safe }}
</head>
<body>
<div class="box">
    <h1>Fubs Online Banking</h1>
    <h2>Welcome Back</h2>

    {% for message in get_flashed_messages() %}
        <div class="message">{{ message }}</div>
    {% endfor %}

    <form method="POST">
        <label>Email Address</label>
        <input name="email" type="email" autocomplete="username" required>

        <label>Password</label>
        <input name="password" type="password"
               autocomplete="current-password" required>

        <button type="submit">Log In</button>
    </form>

    <p>New customer? <a href="{{ url_for('register') }}">Create an account</a></p>
    <p class="warning">Educational demo only. No real banking services.</p>
</div>
</body>
</html>
"""


HOME_PAGE = """
<!DOCTYPE html>
<html>
<head>
    <title>Fubs Online Banking</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    {{ style|safe }}
</head>
<body>
<div class="container">

    <header>
        <h1>Fubs Online Banking</h1>
        <p>Welcome, {{ user["full_name"] }}</p>
        <button type="button" onclick="toggleTheme()">Switch Theme</button>
        <a class="button" href="{{ url_for('logout') }}">Log Out</a>
    </header>

    <section class="balance">
        <p style="color:white">Available Demo Balance</p>
        <h2>₦{{ "{:,.2f}".format(user["balance"]) }}</h2>
        <p style="color:white">Fubs Online Banking · Demo Account</p>
    </section>

    <section class="panel">
        <h2>Quick Actions</h2>
        <div class="grid">
            <div>
                <h3>Add Demo Money</h3>
                <form method="POST" action="{{ url_for('credit') }}">
                    <label>Amount in Naira</label>
                    <input type="number" name="amount"
                           min="1" max="1000000" step="0.01" required>
                    <button type="submit">Add Demo Money</button>
                </form>
            </div>

            <div>
                <h3>Demo Transfer</h3>
                <form method="POST" action="{{ url_for('transfer') }}">
                    <label>Recipient Name</label>
                    <input name="recipient" maxlength="100" required>
                    <label>Amount in Naira</label>
                    <input type="number" name="amount"
                           min="1" max="1000000" step="0.01" required>
                    <button type="submit">Simulate Transfer</button>
                </form>
            </div>
        </div>
    </section>

    <section class="panel">
        <h2>Account Details</h2>
        <p>Name: {{ user["full_name"] }}</p>
        <p>Email: {{ user["email"] }}</p>
        <p>Phone: {{ user["phone"] }}</p>
        <p>Joined: {{ user["created_at"] }}</p>
    </section>

    <section class="panel">
        <h2>Recent Transactions</h2>
        {% if transactions %}
            {% for transaction in transactions %}
                <div class="transaction">
                    <strong>{{ transaction["transaction_type"] }}</strong>
                    <p>{{ transaction["description"] }}</p>
                    <p>{{ transaction["created_at"] }}</p>
                    <strong>
                        {% if transaction["amount"] >= 0 %}+{% else %}-{% endif %}
                        ₦{{ "{:,.2f}".format(transaction["amount"]|abs) }}
                    </strong>
                </div>
            {% endfor %}
        {% else %}
            <p>No transactions yet.</p>
        {% endif %}
    </section>

    <p class="warning">
        Educational prototype only. Money is simulated.
        No real deposits, transfers, or payments take place.
    </p>
</div>

<script>
function toggleTheme() {
    document.body.classList.toggle("light");
    localStorage.setItem(
        "fubs-theme",
        document.body.classList.contains("light") ? "light" : "dark"
    );
}
if (localStorage.getItem("fubs-theme") === "light") {
    document.body.classList.add("light");
}
</script>
</body>
</html>
"""


def render_page(template, **kwargs):
    return render_template_string(template, style=STYLE, **kwargs)


@app.route("/")
@login_required
def home():
    with get_db() as db:
        user = db.execute(
            "SELECT * FROM users WHERE id = ?",
            (session["user_id"],)
        ).fetchone()

        if user is None:
            session.clear()
            return redirect(url_for("login"))

        transactions = db.execute(
            """SELECT * FROM transactions
               WHERE user_id = ?
               ORDER BY id DESC LIMIT 30""",
            (user["id"],)
        ).fetchall()

    return render_page(HOME_PAGE, user=user, transactions=transactions)


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        full_name = request.form.get("full_name", "").strip()
        nin = request.form.get("nin", "").strip()
        phone = request.form.get("phone", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        if not full_name or len(full_name) > 100:
            flash("Enter a valid name.")
            return redirect(url_for("register"))

        if not nin.isdigit() or len(nin) != 11:
            flash("Enter an 11-digit fictional test number.")
            return redirect(url_for("register"))

        if not phone or len(phone) > 20:
            flash("Enter a valid test phone number.")
            return redirect(url_for("register"))

        if len(email) > 254 or "@" not in email:
            flash("Enter a valid email address.")
            return redirect(url_for("register"))

        if len(password) < 8:
            flash("Your password must have at least 8 characters.")
            return redirect(url_for("register"))

        # Store a hash of the fictional test number, not the number itself.
        import hashlib
        nin_hash = hashlib.sha256(nin.encode("utf-8")).hexdigest()
        password_hash = generate_password_hash(password)

        try:
            with get_db() as db:
                cursor = db.execute(
                    """INSERT INTO users
                       (full_name, email, password_hash, phone,
                        nin_hash, balance, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        full_name,
                        email,
                        password_hash,
                        phone,
                        nin_hash,
                        0.0,
                        date.today().isoformat()
                    )
                )
                user_id = cursor.lastrowid

        except sqlite3.IntegrityError:
            flash("That email is already registered. Please log in.")
            return redirect(url_for("register"))

        session.clear()
        session["user_id"] = user_id
        return redirect(url_for("home"))

    return render_page(REGISTER_PAGE)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        with get_db() as db:
            user = db.execute(
                "SELECT id, password_hash FROM users WHERE email = ?",
                (email,)
            ).fetchone()

        if user and check_password_hash(user["password_hash"], password):
            session.clear()
            session["user_id"] = user["id"]
            return redirect(url_for("home"))

        flash("Invalid email or password.")

    return render_page(LOGIN_PAGE)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


def get_amount():
    try:
        amount = float(request.form.get("amount", "0"))
    except (TypeError, ValueError):
        return None

    if amount <= 0 or amount > 1000000:
        return None

    return round(amount, 2)


@app.route("/credit", methods=["POST"])
@login_required
def credit():
    amount = get_amount()

    if amount is None:
        flash("Enter an amount between ₦1 and ₦1,000,000.")
        return redirect(url_for("home"))

    with get_db() as db:
        db.execute(
            "UPDATE users SET balance = balance + ? WHERE id = ?",
            (amount, session["user_id"])
        )
        db.execute(
            """INSERT INTO transactions
               (user_id, transaction_type, amount, description, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (
                session["user_id"],
                "Demo Credit",
                amount,
                "Simulated money; not a real deposit",
                date.today().isoformat()
            )
        )

    flash("Demo money added. No real money was deposited.")
    return redirect(url_for("home"))


@app.route("/transfer", methods=["POST"])
@login_required
def transfer():
    amount = get_amount()
    recipient = request.form.get("recipient", "").strip()

    if amount is None or not recipient or len(recipient) > 100:
        flash("Enter a valid recipient and amount.")
        return redirect(url_for("home"))

    with get_db() as db:
        user = db.execute(
            "SELECT balance FROM users WHERE id = ?",
            (session["user_id"],)
        ).fetchone()

        if user is None or amount > user["balance"]:
            flash("Insufficient demo balance.")
            return redirect(url_for("home"))

        db.execute(
            "UPDATE users SET balance = balance - ? WHERE id = ?",
            (amount, session["user_id"])
        )
        db.execute(
            """INSERT INTO transactions
               (user_id, transaction_type, amount, description, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (
                session["user_id"],
                "Demo Transfer",
                -amount,
                "Simulated transfer to " + recipient,
                date.today().isoformat()
            )
        )

    flash("Demo transfer completed. No real money was sent.")
    return redirect(url_for("home"))


# Create database tables when the app starts.
create_database()


if __name__ == "__main__":
    app.run(
        debug=False,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000"))
    )