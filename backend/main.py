import time
import uuid
import json

from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .database import engine, Base, get_db
from .models import HostelDB, BookingDB, RoommateDB, PropertySubmissionDB, ReviewDB, UserDB
from .schemas import (
    HostelResponse, HostelCreate,
    BookingResponse, BookingCreate, BookingStatusUpdate,
    RoommateResponse, RoommateCreate,
    PropertySubmissionResponse, PropertySubmissionCreate,
    ReviewResponse, ReviewCreate,
    UserRegister, UserLogin, GoogleLogin, PhoneUpdate, PasswordReset, UserResponse, UserRoleUpdate, Token
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
                reviews_res = [ReviewResponse.from_orm(r) for r in reviews_db]
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
                "distance": float(h.distance) if h.distance is not None else 0.5,
                "rating": float(h.rating) if h.rating is not None else 4.8,
                "reviewsCount": int(h.reviews_count) if h.reviews_count is not None else 0,
                "verified": bool(h.verified) if h.verified is not None else True,
                "featured": bool(h.featured) if h.featured is not None else False,
                "imageMain": h.image_main or "assets/images/exterior1.png",
                "imageSingle": h.image_single or "assets/images/room_single.png",
                "imageShared": h.image_shared or "assets/images/room_shared.png",
                "imageMess": h.image_mess or "assets/images/mess.png",
                "address": str(h.address or ""),
                "mapCoords": h.map_coords if isinstance(h.map_coords, dict) else {"top": 40, "left": 50},
                "amenities": h.amenities if isinstance(h.amenities, list) else [],
                "curfew": str(h.curfew or "11:00 PM"),
                "roomSharing": h.room_sharing if isinstance(h.room_sharing, list) else [],
                "description": str(h.description or ""),
                "messMenu": h.mess_menu if isinstance(h.mess_menu, dict) else {},
                "owner_id": h.owner_id,
                "reviews": reviews_res
            }
            results.append(h_dict)
        except Exception as h_err:
            print(f"Error processing hostel {getattr(h, 'id', 'unknown')}: {h_err}")

    return results

@app.get("/api/hostels/{hostel_id}", response_model=HostelResponse)
def get_hostel_detail(hostel_id: str, db: Session = Depends(get_db)):
    h = db.query(HostelDB).filter(HostelDB.id == hostel_id).first()
    if not h:
        raise HTTPException(status_code=404, detail="Hostel not found")

    reviews_res = []
    try:
        reviews_db = db.query(ReviewDB).filter(ReviewDB.hostel_id == h.id).all()
        reviews_res = [ReviewResponse.from_orm(r) for r in reviews_db]
    except Exception:
        pass

    return {
        "id": str(h.id),
        "name": str(h.name or "Student Hostel"),
        "university": str(h.university or "Campus Area"),
        "city": str(h.city or "India"),
        "gender": str(h.gender or "Co-ed"),
        "type": str(h.type or "Student Stay"),
        "rent": float(h.rent) if h.rent is not None else 8000.0,
        "deposit": float(h.deposit) if h.deposit is not None else 5000.0,
        "distance": float(h.distance) if h.distance is not None else 0.5,
        "rating": float(h.rating) if h.rating is not None else 4.8,
        "reviewsCount": int(h.reviews_count) if h.reviews_count is not None else 0,
        "verified": bool(h.verified) if h.verified is not None else True,
        "featured": bool(h.featured) if h.featured is not None else False,
        "imageMain": h.image_main or "assets/images/exterior1.png",
        "imageSingle": h.image_single or "assets/images/room_single.png",
        "imageShared": h.image_shared or "assets/images/room_shared.png",
        "imageMess": h.image_mess or "assets/images/mess.png",
        "address": str(h.address or ""),
        "mapCoords": h.map_coords if isinstance(h.map_coords, dict) else {"top": 40, "left": 50},
        "amenities": h.amenities if isinstance(h.amenities, list) else [],
        "curfew": str(h.curfew or "11:00 PM"),
        "roomSharing": h.room_sharing if isinstance(h.room_sharing, list) else [],
        "description": str(h.description or ""),
        "messMenu": h.mess_menu if isinstance(h.mess_menu, dict) else {},
        "owner_id": h.owner_id,
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


# DEDICATED OWNER PORTAL ENDPOINTS
@app.get("/api/owner/properties", response_model=List[HostelResponse])
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
        hostels = db.query(HostelDB).filter(HostelDB.owner_id == current_user.id).all()

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
            "owner_id": h.owner_id,
            "reviews": reviews_res
        }
        results.append(h_dict)
    return results


@app.post("/api/owner/properties", response_model=HostelResponse)
def create_owner_property(
    hostel_in: HostelCreate,
    current_user: UserDB = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    if current_user.role not in ["owner", "admin"]:
        raise HTTPException(status_code=403, detail="Students cannot list properties. Please log in or register as a Hostel/PG Owner.")

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
        distance=hostel_in.distance,
        rating=hostel_in.rating,
        reviews_count=hostel_in.reviewsCount,
        verified=True,
        featured=hostel_in.featured,
        image_main=hostel_in.imageMain or "assets/images/exterior1.png",
        image_single=hostel_in.imageSingle or "assets/images/room_single.png",
        image_shared=hostel_in.imageShared or "assets/images/room_shared.png",
        image_mess=hostel_in.imageMess or "assets/images/mess.png",
        address=hostel_in.address,
        map_coords_json=json.dumps(hostel_in.mapCoords.dict() if hostel_in.mapCoords else {"top": 40, "left": 50}),
        amenities_json=json.dumps(hostel_in.amenities or ["Wi-Fi", "4-Time Mess", "AC"]),
        curfew=hostel_in.curfew or "11:00 PM",
        room_sharing_json=json.dumps(hostel_in.roomSharing or ["Single", "Double"]),
        description=hostel_in.description,
        mess_menu_json=json.dumps(hostel_in.messMenu.dict() if hostel_in.messMenu else {}),
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
        "distance": new_hostel.distance,
        "rating": new_hostel.rating,
        "reviewsCount": new_hostel.reviews_count,
        "verified": new_hostel.verified,
        "featured": new_hostel.featured,
        "imageMain": new_hostel.image_main,
        "imageSingle": new_hostel.image_single,
        "imageShared": new_hostel.image_shared,
        "imageMess": new_hostel.image_mess,
        "address": new_hostel.address,
        "mapCoords": new_hostel.map_coords,
        "amenities": new_hostel.amenities,
        "curfew": new_hostel.curfew,
        "roomSharing": new_hostel.room_sharing,
        "description": new_hostel.description,
        "messMenu": new_hostel.mess_menu,
        "owner_id": new_hostel.owner_id,
        "reviews": []
    }


@app.put("/api/owner/properties/{hostel_id}", response_model=HostelResponse)
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
    h.distance = hostel_in.distance
    h.address = hostel_in.address
    h.description = hostel_in.description
    if hostel_in.amenities:
        h.amenities = hostel_in.amenities
    if hostel_in.roomSharing:
        h.room_sharing = hostel_in.roomSharing
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
    if not h:
        raise HTTPException(status_code=404, detail="Hostel not found")

    if h.owner_id and h.owner_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to delete this property.")

    db.delete(h)
    db.commit()
    return {"status": "success", "message": "Property removed successfully"}



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

    db.delete(target_user)
    db.commit()
    return {"status": "success", "message": "User account deleted successfully."}



