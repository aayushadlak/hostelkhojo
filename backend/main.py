import os
import time
import uuid
import json
import datetime

from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import random

try:
    from .database import engine, Base, get_db
    from .models import HostelDB, BookingDB, RoommateDB, PropertySubmissionDB, ReviewDB, UserDB, AdminNoticeDB
    from .schemas import (
        HostelResponse, HostelCreate, HostelStatusUpdate,
        BookingResponse, BookingCreate, BookingStatusUpdate,
        RoommateResponse, RoommateCreate,
        PropertySubmissionResponse, PropertySubmissionCreate,
        ReviewResponse, ReviewCreate,
        UserRegister, UserLogin, GoogleLogin, PhoneUpdate, PasswordReset, UserResponse, UserRoleUpdate, Token,
        AdminNoticeResponse, AdminSendOTP, AdminVerifyOTP
    )
    from .auth import get_password_hash, verify_password, create_access_token, get_current_user
    from .seed import seed_database
except ImportError:
    from database import engine, Base, get_db
    from models import HostelDB, BookingDB, RoommateDB, PropertySubmissionDB, ReviewDB, UserDB, AdminNoticeDB
    from schemas import (
        HostelResponse, HostelCreate, HostelStatusUpdate,
        BookingResponse, BookingCreate, BookingStatusUpdate,
        RoommateResponse, RoommateCreate,
        PropertySubmissionResponse, PropertySubmissionCreate,
        ReviewResponse, ReviewCreate,
        UserRegister, UserLogin, GoogleLogin, PhoneUpdate, PasswordReset, UserResponse, UserRoleUpdate, Token,
        AdminNoticeResponse, AdminSendOTP, AdminVerifyOTP
    )
    from auth import get_password_hash, verify_password, create_access_token, get_current_user
    from seed import seed_database


app = FastAPI(
    title="Hostel Khojo India API",
    description="Production REST API backend for Hostel Khojo India website",
    version="1.0.0"
)

ROOT_PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

@app.on_event("startup")
def startup_db_event():
    try:
        Base.metadata.create_all(bind=engine)
        seed_database()
    except Exception as db_err:
        print(f"Startup DB init notice: {db_err}")

# Enable CORS for localhost development and standard web hosting
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ROOT & HEALTHCHECK
@app.get("/")
def root():
    index_file = os.path.join(ROOT_PROJECT_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {
        "status": "online",
        "service": "Hostel Khojo India Backend API 🇮🇳",
        "docs": "/docs",
        "health": "/api/health",
        "hostels": "/api/hostels"
    }

@app.get("/api")
def api_root():
    return {
        "status": "online",
        "service": "Hostel Khojo India Backend API 🇮🇳",
        "docs": "/docs",
        "health": "/api/health",
        "hostels": "/api/hostels"
    }

@app.get("/api/health")
def health_check():
    return {
        "status": "online",
        "service": "Hostel Khojo India Backend API",
        "timestamp": time.time()
    }

@app.get("/app.js")
def serve_app_js():
    f = os.path.join(ROOT_PROJECT_DIR, "app.js")
    if os.path.exists(f):
        return FileResponse(f, media_type="application/javascript")
    raise HTTPException(status_code=404)

@app.get("/styles.css")
def serve_styles_css():
    f = os.path.join(ROOT_PROJECT_DIR, "styles.css")
    if os.path.exists(f):
        return FileResponse(f, media_type="text/css")
    raise HTTPException(status_code=404)

@app.get("/favicon.ico")
def serve_favicon():
    f = os.path.join(ROOT_PROJECT_DIR, "favicon.ico")
    if os.path.exists(f):
        return FileResponse(f)
    raise HTTPException(status_code=404)

@app.get("/favicon.png")
def serve_favicon_png():
    f = os.path.join(ROOT_PROJECT_DIR, "favicon.png")
    if os.path.exists(f):
        return FileResponse(f)
    raise HTTPException(status_code=404)

# Mount subportals if available
for folder_name in ["admin", "owner", "user"]:
    f_path = os.path.join(ROOT_PROJECT_DIR, folder_name)
    if os.path.exists(f_path):
        app.mount(f"/{folder_name}", StaticFiles(directory=f_path, html=True), name=folder_name)



# AUTH ENDPOINTS
@app.post("/api/auth/register", response_model=Token)
def register_user(user_in: UserRegister, db: Session = Depends(get_db)):
    if not user_in.email and not user_in.phone:
        raise HTTPException(status_code=400, detail="Please provide either Phone Number or Email")

    if user_in.email:
        existing_email = db.query(UserDB).filter(UserDB.email == user_in.email).first()
        if existing_email:
            raise HTTPException(status_code=400, detail="Email already registered")

    if user_in.phone:
        existing_phone = db.query(UserDB).filter(UserDB.phone == user_in.phone).first()
        if existing_phone:
            raise HTTPException(status_code=400, detail="Phone number already registered")

    new_user = UserDB(
        id=f"usr_{uuid.uuid4().hex[:10]}",
        email=user_in.email,
        phone=user_in.phone,
        password_hash=get_password_hash(user_in.password),
        full_name=user_in.full_name,
        role=user_in.role or "student"
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    token = create_access_token(data={"sub": new_user.id})
    user_res = UserResponse.from_orm(new_user)
    return Token(access_token=token, token_type="bearer", user=user_res)

# In-memory store for Admin OTPs: { email: { "otp": "123456", "expires_at": float, "attempts": int, "last_sent_at": float } }
ADMIN_OTP_STORE = {}

def send_admin_otp_email(to_email: str, otp_code: str) -> bool:
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", os.getenv("GMAIL_USER", "")).strip()
    smtp_password = os.getenv("SMTP_PASSWORD", os.getenv("GMAIL_APP_PASSWORD", "")).strip()
    smtp_from = os.getenv("SMTP_FROM", f"Hostel Khojo Super Admin <{smtp_user}>" if smtp_user else "Hostel Khojo Super Admin <admin@hostelkhojo.in>").strip()

    if not smtp_user or not smtp_password:
        print(f"[SMTP Error] SMTP_USER and SMTP_PASSWORD are not configured. Cannot dispatch OTP to {to_email}.")
        raise HTTPException(
            status_code=500,
            detail="Gmail SMTP is not configured on the server. Please set SMTP_USER and SMTP_PASSWORD (or GMAIL_APP_PASSWORD) in environment variables to deliver OTP via Gmail."
        )

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Super Admin Verification Code: {otp_code} | Hostel Khojo"
        msg["From"] = smtp_from
        msg["To"] = to_email

        text_content = (
            f"Hostel Khojo Super Admin Verification\n\n"
            f"Your One-Time Password (OTP) is: {otp_code}\n\n"
            f"This code is valid for 10 minutes. Do NOT share this code with anyone.\n"
            f"If you did not request this login, please contact Hostel Khojo support."
        )

        html_content = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hostel Khojo Super Admin OTP</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 24px;">
  <div style="max-width: 520px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 32px; border: 1px solid #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.4);">
    <div style="text-align: center; border-bottom: 1px solid #334155; padding-bottom: 20px; margin-bottom: 24px;">
      <span style="display: inline-block; background: rgba(225, 29, 72, 0.15); border: 1px solid rgba(225, 29, 72, 0.35); color: #f43f5e; padding: 6px 16px; border-radius: 20px; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 12px;">
        Super Admin Security
      </span>
      <h1 style="font-size: 1.4rem; font-weight: 800; color: #ffffff; margin: 0 0 6px 0;">Hostel Khojo Admin Portal</h1>
      <p style="font-size: 0.9rem; color: #94a3b8; margin: 0;">2-Step Gmail One-Time Verification</p>
    </div>
    <p style="font-size: 0.95rem; color: #cbd5e1; line-height: 1.6; margin-bottom: 16px;">Hello Admin,</p>
    <p style="font-size: 0.95rem; color: #cbd5e1; line-height: 1.6; margin-bottom: 24px;">
      Enter the 6-digit verification code below to unlock the <strong>Hostel Khojo Super Admin Command Center</strong>:
    </p>
    <div style="background: #0f172a; border: 2px dashed #f43f5e; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
      <div style="font-size: 2.5rem; font-weight: 900; letter-spacing: 8px; color: #f43f5e; font-family: Consolas, 'Courier New', monospace; margin: 0;">{otp_code}</div>
      <div style="font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-top: 10px; font-weight: 600;">Valid for 10 minutes</div>
    </div>
    <div style="background: rgba(225, 29, 72, 0.1); border-left: 4px solid #f43f5e; padding: 12px 16px; border-radius: 6px; font-size: 0.84rem; color: #fca5a5; margin-bottom: 24px; line-height: 1.5;">
      Security Reminder: Never share this OTP with anyone. Hostel Khojo administrators will never ask for your verification code.
    </div>
    <div style="text-align: center; font-size: 0.78rem; color: #64748b; border-top: 1px solid #334155; padding-top: 18px;">
      Hostel Khojo India &bull; Zero Brokerage Student Accommodation &bull; <a href="https://hostelkhojo.in" style="color: #38bdf8; text-decoration: none;">hostelkhojo.in</a>
    </div>
  </div>
</body>
</html>"""

        part1 = MIMEText(text_content, "plain", "utf-8")
        part2 = MIMEText(html_content, "html", "utf-8")
        msg.attach(part1)
        msg.attach(part2)

        if smtp_port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context) as server:
                server.login(smtp_user, smtp_password)
                server.sendmail(smtp_from, [to_email], msg.as_string())
        else:
            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls(context=ssl.create_default_context())
                server.login(smtp_user, smtp_password)
                server.sendmail(smtp_from, [to_email], msg.as_string())

        print(f"[OK] Real Super Admin Gmail OTP email dispatched to {to_email}")
        return True
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Error] Failed to dispatch email via SMTP to {to_email}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to dispatch OTP to Gmail: {str(e)}. Please check your SMTP settings in server environment."
        )


# SUPER ADMIN GMAIL OTP ENDPOINTS
@app.post("/api/auth/admin/send-otp")
def send_admin_otp(otp_in: AdminSendOTP, db: Session = Depends(get_db)):
    email = otp_in.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Please provide a valid Admin Gmail or Email address.")

    now = time.time()
    if email in ADMIN_OTP_STORE:
        last_sent = ADMIN_OTP_STORE[email].get("last_sent_at", 0)
        if now - last_sent < 45:
            wait_sec = int(45 - (now - last_sent))
            raise HTTPException(status_code=429, detail=f"Please wait {wait_sec}s before requesting a new OTP.")

    # Generate secure 6-digit numeric OTP
    otp_code = f"{random.randint(100000, 999999)}"

    # Dispatch email strictly to Gmail
    send_admin_otp_email(email, otp_code)

    # Save to store after successful email dispatch
    ADMIN_OTP_STORE[email] = {
        "otp": otp_code,
        "expires_at": now + 600, # 10 minutes
        "attempts": 0,
        "last_sent_at": now
    }

    return {
        "status": "success",
        "message": f"Verification code has been sent directly to your Gmail inbox ({email}). Please check your inbox.",
        "email": email,
        "cooldown_seconds": 60
    }


@app.post("/api/auth/admin/verify-otp", response_model=Token)
def verify_admin_otp(verify_in: AdminVerifyOTP, db: Session = Depends(get_db)):
    email = verify_in.email.strip().lower()
    otp = verify_in.otp.strip()

    if not email or not otp:
        raise HTTPException(status_code=400, detail="Gmail address and 6-digit OTP code are required.")

    record = ADMIN_OTP_STORE.get(email)
    now = time.time()

    if not record:
        raise HTTPException(status_code=400, detail="No active OTP found for this email. Please click 'Send OTP' first.")

    if now > record["expires_at"]:
        ADMIN_OTP_STORE.pop(email, None)
        raise HTTPException(status_code=400, detail="OTP code has expired. Please request a new code.")

    if record["attempts"] >= 5:
        ADMIN_OTP_STORE.pop(email, None)
        raise HTTPException(status_code=429, detail="Too many invalid attempts. Please request a fresh OTP.")

    if record["otp"] != otp:
        record["attempts"] += 1
        remaining = 5 - record["attempts"]
        raise HTTPException(status_code=400, detail=f"Invalid OTP code. {remaining} attempt(s) remaining.")

    # OTP is verified! Clear from store
    ADMIN_OTP_STORE.pop(email, None)

    # Find or initialize Admin User in database
    user = db.query(UserDB).filter(UserDB.email == email).first()
    if not user:
        existing_admin = db.query(UserDB).filter(UserDB.role == "admin").first()
        if existing_admin and existing_admin.email == "admin@hostelkhojo.in":
            user = existing_admin
            user.email = email
            db.commit()
            db.refresh(user)
        else:
            user = UserDB(
                id=f"usr_admin_{uuid.uuid4().hex[:8]}",
                email=email,
                phone="9999999999",
                password_hash=get_password_hash(uuid.uuid4().hex),
                full_name="Hostel Khojo Super Admin",
                role="admin"
            )
            db.add(user)
            db.commit()
            db.refresh(user)
    else:
        if user.role != "admin":
            user.role = "admin"
            db.commit()
            db.refresh(user)

    token = create_access_token(data={"sub": user.id, "role": "admin"})
    user_res = UserResponse.from_orm(user)
    return Token(access_token=token, token_type="bearer", user=user_res)


@app.post("/api/auth/login", response_model=Token)
def login_user(user_in: UserLogin, db: Session = Depends(get_db)):
    ident = user_in.identifier.strip()
    ident_lower = ident.lower()

    if ident_lower in ["admin", "superadmin", "root"]:
        user = db.query(UserDB).filter(UserDB.role == "admin").first()
    else:
        user = db.query(UserDB).filter(
            (UserDB.email == ident) | (UserDB.email == ident_lower) | (UserDB.phone == ident)
        ).first()

    if user and user.role == "admin":
        raise HTTPException(
            status_code=403,
            detail="Super Admin accounts must authenticate via Gmail OTP verification."
        )

    if not user or not verify_password(user_in.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid Phone/Email or Password")

    token = create_access_token(data={"sub": user.id})
    user_res = UserResponse.from_orm(user)
    return Token(access_token=token, token_type="bearer", user=user_res)

@app.post("/api/auth/google", response_model=Token)
def google_login(google_in: GoogleLogin, db: Session = Depends(get_db)):
    email = google_in.email.strip().lower()
    user = db.query(UserDB).filter(UserDB.email == email).first()

    target_role = google_in.role if google_in.role in ["owner", "admin"] else "student"

    if not user:
        new_user = UserDB(
            id=f"usr_{uuid.uuid4().hex[:10]}",
            email=email,
            phone=None,
            password_hash=get_password_hash(f"google_{uuid.uuid4().hex}"),
            full_name=google_in.full_name,
            role=target_role
        )
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        user = new_user
    else:
        # Upgrade role to owner if logging in through owner portal
        if target_role == "owner" and user.role == "student":
            user.role = "owner"
            db.commit()
            db.refresh(user)

    token = create_access_token(data={"sub": user.id})
    user_res = UserResponse.from_orm(user)
    return Token(access_token=token, token_type="bearer", user=user_res)


@app.post("/api/auth/update-phone")
def update_phone(phone_in: PhoneUpdate, db: Session = Depends(get_db)):
    user = db.query(UserDB).filter(UserDB.id == phone_in.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.phone = phone_in.phone.strip()
    db.commit()
    return {"status": "success", "phone": user.phone}

@app.post("/api/auth/reset-password")
def reset_password(reset_in: PasswordReset, db: Session = Depends(get_db)):
    ident = reset_in.identifier.strip().lower()
    user = db.query(UserDB).filter(
        (UserDB.email.ilike(ident)) | (UserDB.phone == reset_in.identifier.strip())
    ).first()
    if not user:
        raise HTTPException(status_code=404, detail="No registered account found with this Mobile Phone Number or Email.")
    user.password_hash = get_password_hash(reset_in.new_password)
    db.commit()
    return {"status": "success", "message": "Password updated successfully!"}

@app.get("/api/auth/me", response_model=UserResponse)
def get_me(current_user: UserDB = Depends(get_current_user)):
    return current_user

# HOSTELS ENDPOINTS
@app.get("/api/hostels")
def get_hostels(
    search: Optional[str] = Query(None, description="Search query for name, university, or location"),
    city: Optional[str] = Query(None, description="Filter by city"),
    gender: Optional[str] = Query(None, description="Filter by gender (Co-ed, Girls, Boys)"),
    max_rent: Optional[float] = Query(None, description="Maximum rent"),
    room_sharing: Optional[str] = Query(None, description="Filter by room sharing (Single, Double, Triple)"),
    db: Session = Depends(get_db)
):
    try:
        query = db.query(HostelDB)

        if isinstance(city, str) and city and city != "all":
            query = query.filter(HostelDB.city.ilike(f"%{city}%"))

        if isinstance(gender, str) and gender and gender != "all":
            query = query.filter(HostelDB.gender.ilike(f"%{gender}%"))

        if isinstance(max_rent, (int, float)) and max_rent > 0:
            query = query.filter(HostelDB.rent <= max_rent)

        if isinstance(search, str) and search:
            s = f"%{search.lower()}%"
            query = query.filter(
                (HostelDB.name.ilike(s)) |
                (HostelDB.university.ilike(s)) |
                (HostelDB.city.ilike(s)) |
                (HostelDB.address.ilike(s))
            )

        hostels = query.all()

        # Filter room_sharing in Python if specified (since stored as JSON)
        results = []
        for h in hostels:
            try:
                sharing_list = h.room_sharing or []
                if isinstance(room_sharing, str) and room_sharing and room_sharing != "all":
                    if room_sharing not in sharing_list:
                        continue

                # Get reviews for this hostel safely
                reviews_res = []
                try:
                    reviews_db = db.query(ReviewDB).filter(ReviewDB.hostel_id == h.id).all()
                    for r in reviews_db:
                        reviews_res.append({
                            "id": str(r.id),
                            "hostel_id": str(r.hostel_id),
                            "user_name": str(r.user_name),
                            "major": str(r.major or "Student"),
                            "rating": float(r.rating) if r.rating is not None else 5.0,
                            "comment": str(r.comment or ""),
                            "created_at": r.created_at.isoformat() if hasattr(r.created_at, "isoformat") and r.created_at else str(r.created_at)
                        })
                except Exception as rev_err:
                    print(f"Notice: Failed to fetch reviews for hostel {h.id}: {rev_err}")

                h_dict = {
                    "id": str(h.id),
                    "name": str(h.name or "Student Hostel"),
                    "university": str(h.university or "Campus Area"),
                    "city": str(h.city or "India"),
                    "gender": str(h.gender or "Co-ed"),
                    "type": str(h.type or "Student Stay"),
                    "rent": float(h.rent) if h.rent is not None else 8000.0,
                    "deposit": float(h.deposit) if h.deposit is not None else 5000.0,
                    "registrationFee": float(getattr(h, "registration_fee", 0.0) or 0.0),
                    "distance": float(h.distance) if h.distance is not None else 0.5,
                    "rating": float(h.rating) if h.rating is not None else 4.8,
                    "reviewsCount": int(h.reviews_count) if h.reviews_count is not None else 0,
                    "verified": bool(h.verified) if h.verified is not None else True,
                    "featured": bool(h.featured) if h.featured is not None else False,
                    "imageMain": h.image_main or "assets/images/exterior1.png",
                    "imageSingle": h.image_single or "assets/images/room_single.png",
                    "imageShared": h.image_shared or "assets/images/room_shared.png",
                    "imageWashroom": getattr(h, "image_washroom", None) or "assets/images/room_shared.png",
                    "imageMess": h.image_mess or "assets/images/mess.png",
                    "address": str(h.address or ""),
                    "mapLink": getattr(h, "map_link", "") or "",
                    "lat": float(h.lat) if getattr(h, "lat", None) is not None else 28.6922,
                    "lng": float(h.lng) if getattr(h, "lng", None) is not None else 77.2100,
                    "mapCoords": h.map_coords if isinstance(h.map_coords, dict) else {"top": 40, "left": 50},
                    "amenities": h.amenities if isinstance(h.amenities, list) else [],
                    "curfew": str(h.curfew or "11:00 PM"),
                    "roomSharing": h.room_sharing if isinstance(h.room_sharing, list) else [],
                    "occupancyPricing": h.occupancy_pricing if isinstance(h.occupancy_pricing, dict) else {},
                    "description": str(h.description or ""),
                    "messMenu": h.mess_menu if isinstance(h.mess_menu, dict) else {},
                    "owner_id": getattr(h, "owner_id", None),
                    "is_live": bool(getattr(h, "is_live", True) if getattr(h, "is_live", True) is not None else True),
                    "reviews": reviews_res
                }
                results.append(h_dict)

            except Exception as h_err:
                print(f"Error processing hostel {getattr(h, 'id', 'unknown')}: {h_err}")

        return results
    except Exception as err:
        print(f"Top-level get_hostels error: {err}")
        return []

@app.get("/api/hostels/{hostel_id}")
def get_hostel_detail(hostel_id: str, db: Session = Depends(get_db)):
    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    if not h:
        raise HTTPException(status_code=404, detail="Hostel not found")

    reviews_res = []
    try:
        if hasattr(h, "reviews") and h.reviews:
            reviews_res = [
                {
                    "id": r.id,
                    "userName": r.user_name,
                    "rating": r.rating,
                    "comment": r.comment,
                    "createdAt": r.created_at.strftime("%Y-%m-%d") if r.created_at else "2026-08-20"
                }
                for r in h.reviews
            ]
    except Exception as e:
        reviews_res = []

    return {
        "id": h.id,
        "name": h.name,
        "university": h.university,
        "city": h.city,
        "gender": str(h.gender or "Co-ed"),
        "type": str(h.type or "Student Stay"),
        "rent": float(h.rent) if h.rent is not None else 8000.0,
        "deposit": float(h.deposit) if h.deposit is not None else 5000.0,
        "registrationFee": float(getattr(h, "registration_fee", 0.0) or 0.0),
        "distance": float(h.distance) if h.distance is not None else 0.5,
        "rating": float(h.rating) if h.rating is not None else 4.8,
        "reviewsCount": int(h.reviews_count) if h.reviews_count is not None else 0,
        "verified": bool(h.verified) if h.verified is not None else True,
        "featured": bool(h.featured) if h.featured is not None else False,
        "imageMain": h.image_main or "assets/images/exterior1.png",
        "imageSingle": h.image_single or "assets/images/room_single.png",
        "imageShared": h.image_shared or "assets/images/room_shared.png",
        "imageWashroom": getattr(h, "image_washroom", None) or "assets/images/room_shared.png",
        "imageMess": h.image_mess or "assets/images/mess.png",
        "address": str(h.address or ""),
        "mapLink": getattr(h, "map_link", "") or "",
        "lat": float(h.lat) if getattr(h, "lat", None) is not None else 28.6922,
        "lng": float(h.lng) if getattr(h, "lng", None) is not None else 77.2100,
        "mapCoords": h.map_coords if isinstance(h.map_coords, dict) else {"top": 40, "left": 50},
        "amenities": h.amenities if isinstance(h.amenities, list) else [],
        "curfew": str(h.curfew or "11:00 PM"),
        "roomSharing": h.room_sharing if isinstance(h.room_sharing, list) else [],
        "occupancyPricing": h.occupancy_pricing if isinstance(h.occupancy_pricing, dict) else {},
        "description": str(h.description or ""),
        "messMenu": h.mess_menu if isinstance(h.mess_menu, dict) else {},
        "owner_id": h.owner_id,
        "is_live": bool(getattr(h, "is_live", True) if getattr(h, "is_live", True) is not None else True),
        "reviews": reviews_res
    }

# REVIEWS ENDPOINT
@app.post("/api/hostels/{hostel_id}/reviews", response_model=ReviewResponse)
def add_review(hostel_id: str, review_in: ReviewCreate, db: Session = Depends(get_db)):
    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    if not h:
        raise HTTPException(status_code=404, detail="Hostel not found")

    new_review = ReviewDB(
        id=f"rev_{uuid.uuid4().hex[:10]}",
        hostel_id=hostel_id,
        user_name=review_in.user_name,
        major=review_in.major,
        rating=review_in.rating,
        comment=review_in.comment
    )
    db.add(new_review)
    
    # Recalculate hostel average rating
    all_reviews = db.query(ReviewDB).filter(ReviewDB.hostel_id == hostel_id).all()
    new_count = len(all_reviews) + 1
    new_avg = round((sum([r.rating for r in all_reviews]) + review_in.rating) / new_count, 2)

    h.rating = new_avg
    h.reviews_count = new_count

    db.commit()
    db.refresh(new_review)
    return new_review

# BOOKINGS ENDPOINTS
@app.post("/api/bookings", response_model=BookingResponse)
def create_booking(booking_in: BookingCreate, db: Session = Depends(get_db)):
    new_booking = BookingDB(
        id=f"bk_{uuid.uuid4().hex[:10]}",
        hostel_id=booking_in.hostel_id,
        user_name=booking_in.user_name or "Student Visitor",
        phone=booking_in.phone,
        visit_date=booking_in.visit_date,
        room_sharing=booking_in.room_sharing,
        status="Scheduled"
    )
    db.add(new_booking)
    db.commit()
    db.refresh(new_booking)
    return new_booking

# ROOMMATES ENDPOINTS
@app.get("/api/roommates", response_model=List[RoommateResponse])
def get_roommates(
    major: Optional[str] = Query(None),
    habit: Optional[str] = Query(None),
    diet: Optional[str] = Query(None),
    db: Session = Depends(get_db)
):
    query = db.query(RoommateDB)
    roommates = query.order_by(RoommateDB.created_at.desc()).all()

    results = []
    for r in roommates:
        if major and major != "all" and major.lower() not in r.major.lower():
            continue
        if habit and habit != "all" and r.sleep_habit != habit:
            continue
        if diet and diet != "all" and r.diet != diet:
            continue

        results.append({
            "id": r.id,
            "name": r.name,
            "gender": r.gender,
            "university": r.university,
            "major": r.major,
            "budget": r.budget,
            "sleepHabit": r.sleep_habit,
            "diet": r.diet,
            "bio": r.bio,
            "avatar": r.avatar
        })
    return results

@app.post("/api/roommates", response_model=RoommateResponse)
def create_roommate(roommate_in: RoommateCreate, db: Session = Depends(get_db)):
    avatar = roommate_in.avatar
    if not avatar:
        parts = roommate_in.name.split()
        avatar = "".join([p[0].upper() for p in parts[:2]]) if parts else "ST"

    new_rm = RoommateDB(
        id=f"rm_{uuid.uuid4().hex[:10]}",
        name=roommate_in.name,
        gender=roommate_in.gender,
        university=roommate_in.university,
        major=roommate_in.major,
        budget=roommate_in.budget,
        sleep_habit=roommate_in.sleep_habit,
        diet=roommate_in.diet,
        bio=roommate_in.bio,
        avatar=avatar
    )
    db.add(new_rm)
    db.commit()
    db.refresh(new_rm)

    return {
        "id": new_rm.id,
        "name": new_rm.name,
        "gender": new_rm.gender,
        "university": new_rm.university,
        "major": new_rm.major,
        "budget": new_rm.budget,
        "sleepHabit": new_rm.sleep_habit,
        "diet": new_rm.diet,
        "bio": new_rm.bio,
        "avatar": new_rm.avatar
    }

@app.delete("/api/roommates/all")
def delete_all_roommates(db: Session = Depends(get_db)):
    count = db.query(RoommateDB).delete()
    db.commit()
    return {"status": "success", "deleted_count": count}


# OWNER PROPERTY SUBMISSIONS ENDPOINTS
@app.post("/api/owner-submissions", response_model=PropertySubmissionResponse)
def submit_property(sub_in: PropertySubmissionCreate, db: Session = Depends(get_db)):
    prop_id = f"h_{uuid.uuid4().hex[:8]}"

    # Save submission record
    new_sub = PropertySubmissionDB(
        id=f"sub_{uuid.uuid4().hex[:8]}",
        owner_name=sub_in.owner_name,
        owner_phone=sub_in.owner_phone,
        property_name=sub_in.property_name,
        city=sub_in.city,
        address=sub_in.address,
        rooms_count=sub_in.rooms_count,
        rent_range=sub_in.rent_range,
        status="Verified & Published"
    )
    db.add(new_sub)

    # Parse numerical rent from string range (e.g. "8000" or "8000-12000")
    try:
        rent_num = float(''.join(filter(str.isdigit, sub_in.rent_range.split('-')[0])))
    except Exception:
        rent_num = 9500.0

    # Publish real Hostel record directly to search index
    new_hostel = HostelDB(
        id=prop_id,
        name=sub_in.property_name,
        university=f"{sub_in.city} University Campus",
        city=sub_in.city,
        gender="Co-ed",
        type="Verified Student PG & Hostel",
        rent=rent_num,
        deposit=round(rent_num * 0.8),
        distance=0.4,
        rating=5.0,
        reviews_count=0,
        verified=True,
        featured=True,
        image_main="assets/images/exterior1.png",
        image_single="assets/images/room_single.png",
        image_shared="assets/images/room_shared.png",
        image_mess="assets/images/mess.png",
        address=sub_in.address,
        map_coords_json=json.dumps({"top": 45, "left": 50}),
        amenities_json=json.dumps(["Wi-Fi", "4-Time Mess", "AC", "CCTV Security", "24x7 Power Backup"]),
        curfew="11:00 PM",
        room_sharing_json=json.dumps(["Single", "Double", "Triple"]),
        description=f"Verified premium student stay managed by {sub_in.owner_name}. Located near key college campuses in {sub_in.city}. Contact owner directly: {sub_in.owner_phone}.",
        mess_menu_json=json.dumps({
            "breakfast": "Nutritious Breakfast & Hot Chai / Coffee",
            "lunch": "Full North/South Indian Meals",
            "snacks": "Evening Tea & Snacks",
            "dinner": "Multi-course Special Dinner"
        })
    )
    db.add(new_hostel)

    db.commit()
    db.refresh(new_sub)
    return new_sub


from sqlalchemy import or_

# DEDICATED OWNER PORTAL ENDPOINTS
@app.get("/api/owner/properties")
def get_owner_properties(
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Students cannot list or manage properties. Please log in as a Hostel/PG Owner.")

    # Admins see all properties; Owners strictly see only their own listed properties!
    if current_user.role == "admin":
        hostels = db.query(HostelDB).all()
    else:
        filters = [HostelDB.owner_id == current_user.id]
        if current_user.email:
            filters.append(HostelDB.owner_id == current_user.email)
        if current_user.phone:
            filters.append(HostelDB.owner_id == current_user.phone)
        hostels = db.query(HostelDB).filter(or_(*filters)).all()

    results = []
    for h in hostels:
        reviews_db = db.query(ReviewDB).filter(ReviewDB.hostel_id == h.id).all()
        reviews_res = [ReviewResponse.from_orm(r) for r in reviews_db]
        h_dict = {
            "id": h.id,
            "name": h.name,
            "university": h.university,
            "city": h.city,
            "gender": h.gender,
            "type": h.type,
            "rent": h.rent,
            "deposit": h.deposit,
            "registrationFee": float(getattr(h, "registration_fee", 0.0) or 0.0),
            "distance": h.distance,
            "rating": h.rating,
            "reviewsCount": h.reviews_count,
            "verified": h.verified,
            "featured": h.featured,
            "imageMain": h.image_main,
            "imageSingle": h.image_single,
            "imageShared": h.image_shared,
            "imageWashroom": getattr(h, "image_washroom", None) or "assets/images/room_shared.png",
            "imageMess": h.image_mess,
            "address": h.address,
            "mapCoords": h.map_coords,
            "amenities": h.amenities,
            "curfew": h.curfew,
            "roomSharing": h.room_sharing,
            "occupancyPricing": h.occupancy_pricing if isinstance(h.occupancy_pricing, dict) else {},
            "description": h.description,
            "messMenu": h.mess_menu,
            "owner_id": h.owner_id,
            "is_live": bool(getattr(h, "is_live", True) if getattr(h, "is_live", True) is not None else True),
            "reviews": reviews_res
        }
        results.append(h_dict)
    return results


@app.post("/api/owner/properties")
def create_owner_property(
    hostel_in: HostelCreate,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Students cannot list properties. Please log in or register as a Hostel/PG Owner.")

    try:
        new_id = f"h_{uuid.uuid4().hex[:8]}"
        new_hostel = HostelDB(
            id=new_id,
            name=hostel_in.name,
            university=hostel_in.university,
            city=hostel_in.city,
            gender=hostel_in.gender,
            type=hostel_in.type,
            rent=hostel_in.rent,
            deposit=hostel_in.deposit,
            registration_fee=float(hostel_in.registrationFee or 0.0),
            distance=hostel_in.distance,
            rating=hostel_in.rating,
            reviews_count=hostel_in.reviewsCount,
            verified=True,
            featured=hostel_in.featured,
            is_live=True,
            image_main=hostel_in.imageMain or "assets/images/exterior1.png",
            image_single=hostel_in.imageSingle or "assets/images/room_single.png",
            image_shared=hostel_in.imageShared or "assets/images/room_shared.png",
            image_washroom=hostel_in.imageWashroom or "assets/images/room_shared.png",
            image_mess=hostel_in.imageMess or "assets/images/mess.png",
            address=hostel_in.address,
            map_link=getattr(hostel_in, "mapLink", "") or "",
            lat=float(hostel_in.lat) if getattr(hostel_in, "lat", None) is not None else 28.6922,
            lng=float(hostel_in.lng) if getattr(hostel_in, "lng", None) is not None else 77.2100,
            map_coords_json=json.dumps(hostel_in.mapCoords if isinstance(hostel_in.mapCoords, dict) else {"top": 40, "left": 50}),
            amenities_json=json.dumps(hostel_in.amenities or ["Wi-Fi", "4-Time Mess", "AC"]),
            curfew=hostel_in.curfew or "11:00 PM",
            room_sharing_json=json.dumps(hostel_in.roomSharing or ["Single", "Double"]),
            occupancy_pricing_json=json.dumps(hostel_in.occupancyPricing if isinstance(hostel_in.occupancyPricing, dict) else {}),
            description=hostel_in.description or "",
            mess_menu_json=json.dumps(hostel_in.messMenu if isinstance(hostel_in.messMenu, dict) else {}),
            owner_id=current_user.id
        )
        db.add(new_hostel)
        db.commit()
        db.refresh(new_hostel)

        return {
            "id": new_hostel.id,
            "name": new_hostel.name,
            "university": new_hostel.university,
            "city": new_hostel.city,
            "gender": new_hostel.gender,
            "type": new_hostel.type,
            "rent": new_hostel.rent,
            "deposit": new_hostel.deposit,
            "registrationFee": float(getattr(new_hostel, "registration_fee", 0.0) or 0.0),
            "distance": new_hostel.distance,
            "rating": new_hostel.rating,
            "reviewsCount": new_hostel.reviews_count,
            "verified": new_hostel.verified,
            "featured": new_hostel.featured,
            "is_live": bool(getattr(new_hostel, "is_live", True)),
            "imageMain": new_hostel.image_main,
            "imageSingle": new_hostel.image_single,
            "imageShared": new_hostel.image_shared,
            "imageWashroom": new_hostel.image_washroom,
            "imageMess": new_hostel.image_mess,
            "address": new_hostel.address,
            "mapLink": getattr(new_hostel, "map_link", "") or "",
            "lat": float(new_hostel.lat) if getattr(new_hostel, "lat", None) is not None else 28.6922,
            "lng": float(new_hostel.lng) if getattr(new_hostel, "lng", None) is not None else 77.2100,
            "mapCoords": new_hostel.map_coords,
            "amenities": new_hostel.amenities,
            "curfew": new_hostel.curfew,
            "roomSharing": new_hostel.room_sharing,
            "occupancyPricing": new_hostel.occupancy_pricing if isinstance(new_hostel.occupancy_pricing, dict) else {},
            "description": new_hostel.description,
            "messMenu": new_hostel.mess_menu,
            "owner_id": new_hostel.owner_id,
            "reviews": []
        }
    except Exception as err:
        db.rollback()
        print(f"Error in create_owner_property: {err}")
        raise HTTPException(status_code=500, detail=f"Failed to create property: {str(err)}")


@app.put("/api/owner/properties/{hostel_id}")
def update_owner_property(
    hostel_id: str,
    hostel_in: HostelCreate,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Students cannot edit properties. Please log in as a Hostel/PG Owner.")

    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    if not h:
        raise HTTPException(status_code=404, detail="Hostel not found")

    if h.owner_id and h.owner_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to edit this property.")

    h.name = hostel_in.name
    h.university = hostel_in.university
    h.city = hostel_in.city
    h.gender = hostel_in.gender
    h.type = hostel_in.type
    h.rent = hostel_in.rent
    h.deposit = hostel_in.deposit
    if hostel_in.registrationFee is not None:
        h.registration_fee = float(hostel_in.registrationFee)
    h.distance = hostel_in.distance
    h.address = hostel_in.address
    if hasattr(hostel_in, "mapLink") and hostel_in.mapLink is not None:
        h.map_link = hostel_in.mapLink
    if hasattr(hostel_in, "lat") and hostel_in.lat is not None:
        h.lat = hostel_in.lat
    if hasattr(hostel_in, "lng") and hostel_in.lng is not None:
        h.lng = hostel_in.lng
    h.description = hostel_in.description
    if hostel_in.imageMain is not None:
        h.image_main = hostel_in.imageMain
    if hostel_in.imageSingle is not None:
        h.image_single = hostel_in.imageSingle
    if hostel_in.imageShared is not None:
        h.image_shared = hostel_in.imageShared
    if hostel_in.imageWashroom is not None:
        h.image_washroom = hostel_in.imageWashroom
    if hostel_in.imageMess is not None:
        h.image_mess = hostel_in.imageMess
    if hostel_in.amenities is not None:
        h.amenities = hostel_in.amenities
    if hostel_in.roomSharing is not None:
        h.room_sharing = hostel_in.roomSharing
    if hostel_in.occupancyPricing is not None:
        h.occupancy_pricing = hostel_in.occupancyPricing
    if hostel_in.curfew:
        h.curfew = hostel_in.curfew

    db.commit()
    db.refresh(h)

    reviews_db = db.query(ReviewDB).filter(ReviewDB.hostel_id == h.id).all()
    reviews_res = [ReviewResponse.from_orm(r) for r in reviews_db]

    return {
        "id": h.id,
        "name": h.name,
        "university": h.university,
        "city": h.city,
        "gender": h.gender,
        "type": h.type,
        "rent": h.rent,
        "deposit": h.deposit,
        "registrationFee": float(getattr(h, "registration_fee", 0.0) or 0.0),
        "distance": h.distance,
        "rating": h.rating,
        "reviewsCount": h.reviews_count,
        "verified": h.verified,
        "featured": h.featured,
        "is_live": bool(getattr(h, "is_live", True) if getattr(h, "is_live", True) is not None else True),
        "imageMain": h.image_main,
        "imageSingle": h.image_single,
        "imageShared": h.image_shared,
        "imageWashroom": h.image_washroom,
        "imageMess": h.image_mess,
        "address": h.address,
        "mapCoords": h.map_coords,
        "amenities": h.amenities,
        "curfew": h.curfew,
        "roomSharing": h.room_sharing,
        "occupancyPricing": h.occupancy_pricing if isinstance(h.occupancy_pricing, dict) else {},
        "description": h.description,
        "messMenu": h.mess_menu,
        "owner_id": h.owner_id,
        "reviews": reviews_res
    }


@app.delete("/api/owner/properties/{hostel_id}")
def delete_owner_property(
    hostel_id: str,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Students cannot delete properties. Please log in as a Hostel/PG Owner.")

    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    sub = db.query(PropertySubmissionDB).filter(PropertySubmissionDB.id == hostel_id).first()

    if not h and not sub:
        raise HTTPException(status_code=404, detail="Hostel property not found")

    if h and h.owner_id and h.owner_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to delete this property.")

    # Cascade delete associated records across all database tables
    try:
        db.query(BookingDB).filter(BookingDB.hostel_id == hostel_id).delete(synchronize_session=False)
        db.query(ReviewDB).filter(ReviewDB.hostel_id == hostel_id).delete(synchronize_session=False)
        db.query(PropertySubmissionDB).filter(PropertySubmissionDB.id == hostel_id).delete(synchronize_session=False)
        if h:
            db.delete(h)
        db.commit()
    except Exception as del_err:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete property globally: {del_err}")

    return {"status": "success", "message": "Property listing deleted globally."}


@app.put("/api/owner/properties/{hostel_id}/status")
@app.put("/api/admin/hostels/{hostel_id}/status")
def toggle_hostel_live_status(
    hostel_id: str,
    status_in: HostelStatusUpdate,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Hostel Owner or Admin authorization required.")

    h = db.query(HostelDB).filter(
        (HostelDB.id == hostel_id) | (HostelDB.name.ilike(hostel_id))
    ).first()

    if not h:
        sub = db.query(PropertySubmissionDB).filter(
            (PropertySubmissionDB.id == hostel_id) | (PropertySubmissionDB.name.ilike(hostel_id))
        ).first()
        if not sub:
            raise HTTPException(status_code=404, detail="Hostel property not found.")
        return {
            "status": "success",
            "message": f"Hostel status updated to {'Online (Live)' if status_in.is_live else 'Offline (Hidden)'}",
            "is_live": status_in.is_live
        }

    if h.owner_id and h.owner_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to modify status for this property.")

    h.is_live = status_in.is_live
    db.commit()
    db.refresh(h)
    return {
        "status": "success",
        "message": f"Hostel status updated to {'Online (Live)' if h.is_live else 'Offline (Hidden)'}",
        "is_live": bool(h.is_live)
    }






@app.get("/api/owner/bookings", response_model=List[BookingResponse])
def get_owner_bookings(
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Owner portal access required")

    # Admins see all bookings; Owners strictly see bookings for their own properties
    if current_user.role == "admin":
        bookings = db.query(BookingDB).order_by(BookingDB.created_at.desc()).all()
    else:
        owner_hostel_ids = [h.id for h in db.query(HostelDB).filter(HostelDB.owner_id == current_user.id).all()]
        bookings = db.query(BookingDB).filter(BookingDB.hostel_id.in_(owner_hostel_ids)).order_by(BookingDB.created_at.desc()).all()
    return bookings


@app.put("/api/owner/bookings/{booking_id}/status", response_model=BookingResponse)
def update_owner_booking_status(
    booking_id: str,
    status_in: BookingStatusUpdate,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Owner portal access required")

    b = db.query(BookingDB).filter(BookingDB.id == booking_id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Booking not found")

    b.status = status_in.status
    db.commit()
    db.refresh(b)
    return b


# SUPER ADMIN CONTROL PANEL ENDPOINTS
@app.get("/api/admin/stats")
def get_admin_stats(
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Super Admin authorization required.")

    total_users = db.query(UserDB).count()
    students_count = db.query(UserDB).filter(UserDB.role == "student").count()
    owners_count = db.query(UserDB).filter(UserDB.role == "owner").count()
    admins_count = db.query(UserDB).filter(UserDB.role == "admin").count()
    total_hostels = db.query(HostelDB).count()
    total_bookings = db.query(BookingDB).count()
    total_roommates = db.query(RoommateDB).count()

    return {
        "total_users": total_users,
        "students_count": students_count,
        "owners_count": owners_count,
        "admins_count": admins_count,
        "total_hostels": total_hostels,
        "total_bookings": total_bookings,
        "total_roommates": total_roommates
    }

@app.get("/api/admin/users", response_model=List[UserResponse])
def get_admin_users(
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Super Admin authorization required.")

    users = db.query(UserDB).order_by(UserDB.created_at.desc()).all()
    return users

@app.put("/api/admin/users/{user_id}/role", response_model=UserResponse)
def update_user_role(
    user_id: str,
    role_in: UserRoleUpdate,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Super Admin authorization required.")

    target_user = db.query(UserDB).filter(UserDB.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User account not found.")

    if role_in.role not in ["student", "owner", "admin"]:
        raise HTTPException(status_code=400, detail="Invalid role type. Must be student, owner, or admin.")

    target_user.role = role_in.role
    db.commit()
    db.refresh(target_user)
    return target_user

@app.delete("/api/admin/users/{user_id}")
def delete_user_account(
    user_id: str,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Super Admin authorization required.")

    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Super Admin cannot delete their own active account.")

    target_user = db.query(UserDB).filter(UserDB.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User account not found.")

    try:
        db.query(HostelDB).filter(HostelDB.owner_id == user_id).update({"owner_id": None})
        db.query(PropertySubmissionDB).filter(PropertySubmissionDB.owner_id == user_id).update({"owner_id": None})
        db.delete(target_user)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete user: {str(e)}")

    return {"status": "success", "message": "User account deleted successfully."}


@app.delete("/api/admin/hostels/{hostel_id}")
def delete_admin_hostel_property(
    hostel_id: str,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Super Admin authorization required.")

    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    sub = db.query(PropertySubmissionDB).filter(PropertySubmissionDB.id == hostel_id).first()

    if not h and not sub:
        raise HTTPException(status_code=404, detail="Hostel property not found.")

    owner_id = h.owner_id if h else (sub.owner_id if sub else None)
    property_name = h.name if h else (sub.property_name if sub else "PG / Hostel Property")

    try:
        # If the property had an owner, record an official Admin removal notification
        if owner_id:
            notice = AdminNoticeDB(
                id=f"notif_{uuid.uuid4().hex[:10]}",
                owner_id=owner_id,
                property_id=hostel_id,
                property_name=property_name,
                message=f"Admin has removed this property: '{property_name}'",
                reason="Removed by Super Admin",
                created_at=datetime.datetime.utcnow(),
                is_dismissed=False
            )
            db.add(notice)

        # Cascade delete associated bookings, reviews, and property submissions
        db.query(BookingDB).filter(BookingDB.hostel_id == hostel_id).delete(synchronize_session=False)
        db.query(ReviewDB).filter(ReviewDB.hostel_id == hostel_id).delete(synchronize_session=False)
        db.query(PropertySubmissionDB).filter(PropertySubmissionDB.id == hostel_id).delete(synchronize_session=False)

        if h:
            db.delete(h)
        db.commit()
    except Exception as del_err:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete hostel property globally: {del_err}")

    return {
        "status": "success",
        "message": "Hostel property deleted globally by Super Admin.",
        "owner_notified": bool(owner_id),
        "property_name": property_name
    }


# OWNER NOTIFICATIONS ENDPOINTS (Admin removal notices & alerts)
@app.get("/api/owner/notifications", response_model=List[AdminNoticeResponse])
def get_owner_notifications(
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Owner authorization required.")

    filters = [AdminNoticeDB.owner_id == current_user.id]
    if current_user.email:
        filters.append(AdminNoticeDB.owner_id == current_user.email)
    if current_user.phone:
        filters.append(AdminNoticeDB.owner_id == current_user.phone)

    notices = db.query(AdminNoticeDB).filter(
        or_(*filters),
        AdminNoticeDB.is_dismissed == False
    ).order_by(AdminNoticeDB.created_at.desc()).all()

    return notices


@app.delete("/api/owner/notifications/{notice_id}")
def dismiss_owner_notification(
    notice_id: str,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Owner authorization required.")

    notice = db.query(AdminNoticeDB).filter(AdminNoticeDB.id == notice_id).first()
    if not notice:
        raise HTTPException(status_code=404, detail="Notification not found.")

    notice.is_dismissed = True
    db.commit()
    return {"status": "success", "message": "Notification dismissed successfully."}



if __name__ == "__main__":
    import os
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("backend.main:app", host="0.0.0.0", port=port, reload=False)





