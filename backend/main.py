import time
import uuid
import json

from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .database import engine, Base, get_db
from .models import HostelDB, BookingDB, RoommateDB, PropertySubmissionDB, ReviewDB, UserDB
from .schemas import (
    HostelResponse, HostelCreate,
    BookingResponse, BookingCreate,
    RoommateResponse, RoommateCreate,
    PropertySubmissionResponse, PropertySubmissionCreate,
    ReviewResponse, ReviewCreate,
    UserRegister, UserLogin, UserResponse, Token
)
from .auth import get_password_hash, verify_password, create_access_token, get_current_user
from .seed import seed_database

# Create database tables and seed initial data
Base.metadata.create_all(bind=engine)
seed_database()

app = FastAPI(
    title="Hostel Khojo India API",
    description="Production REST API backend for Hostel Khojo India website",
    version="1.0.0"
)

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

@app.post("/api/auth/login", response_model=Token)
def login_user(user_in: UserLogin, db: Session = Depends(get_db)):
    ident = user_in.identifier.strip()
    ident_lower = ident.lower()
    user = db.query(UserDB).filter(
        (UserDB.email == ident) | (UserDB.email == ident_lower) | (UserDB.phone == ident)
    ).first()

    if not user or not verify_password(user_in.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid Phone/Email or Password")

    token = create_access_token(data={"sub": user.id})
    user_res = UserResponse.from_orm(user)
    return Token(access_token=token, token_type="bearer", user=user_res)

@app.get("/api/auth/me", response_model=UserResponse)
def get_me(current_user: UserDB = Depends(get_current_user)):
    return current_user

# HOSTELS ENDPOINTS
@app.get("/api/hostels", response_model=List[HostelResponse])
def get_hostels(
    search: Optional[str] = Query(None, description="Search query for name, university, or location"),
    city: Optional[str] = Query(None, description="Filter by city"),
    gender: Optional[str] = Query(None, description="Filter by gender (Co-ed, Girls, Boys)"),
    max_rent: Optional[float] = Query(None, description="Maximum rent"),
    room_sharing: Optional[str] = Query(None, description="Filter by room sharing (Single, Double, Triple)"),
    db: Session = Depends(get_db)
):
    query = db.query(HostelDB)

    if city and city != "all":
        query = query.filter(HostelDB.city.ilike(f"%{city}%"))

    if gender and gender != "all":
        query = query.filter(HostelDB.gender.ilike(f"%{gender}%"))

    if max_rent and max_rent > 0:
        query = query.filter(HostelDB.rent <= max_rent)

    if search:
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
        if room_sharing and room_sharing != "all":
            if room_sharing not in h.room_sharing:
                continue

        # Get reviews for this hostel
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
            "distance": h.distance,
            "rating": h.rating,
            "reviewsCount": h.reviews_count,
            "verified": h.verified,
            "featured": h.featured,
            "imageMain": h.image_main,
            "imageSingle": h.image_single,
            "imageShared": h.image_shared,
            "imageMess": h.image_mess,
            "address": h.address,
            "mapCoords": h.map_coords,
            "amenities": h.amenities,
            "curfew": h.curfew,
            "roomSharing": h.room_sharing,
            "description": h.description,
            "messMenu": h.mess_menu,
            "reviews": reviews_res
        }
        results.append(h_dict)

    return results

@app.get("/api/hostels/{hostel_id}", response_model=HostelResponse)
def get_hostel_detail(hostel_id: str, db: Session = Depends(get_db)):
    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    if not h:
        raise HTTPException(status_code=404, detail="Hostel not found")

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
        "distance": h.distance,
        "rating": h.rating,
        "reviewsCount": h.reviews_count,
        "verified": h.verified,
        "featured": h.featured,
        "imageMain": h.image_main,
        "imageSingle": h.image_single,
        "imageShared": h.image_shared,
        "imageMess": h.image_mess,
        "address": h.address,
        "mapCoords": h.map_coords,
        "amenities": h.amenities,
        "curfew": h.curfew,
        "roomSharing": h.room_sharing,
        "description": h.description,
        "messMenu": h.mess_menu,
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

