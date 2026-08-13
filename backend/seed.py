import json
from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, ReviewDB, UserDB
from .auth import get_password_hash

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # 1. Seed / update clean demo user account for instant testing
        demo_user = db.query(UserDB).filter(
            (UserDB.phone == "9876543210") | (UserDB.email == "student@hostelkhojo.in")
        ).first()

        if not demo_user:
            demo_user = UserDB(
                id="usr_demo_1",
                full_name="Demonstration Student",
                email="student@hostelkhojo.in",
                phone="9876543210",
                password_hash=get_password_hash("password123"),
                role="student"
            )
            db.add(demo_user)
        else:
            # Ensure password hash is always up-to-date and matches password123
            demo_user.password_hash = get_password_hash("password123")

        # 2. Seed initial hostels if database is empty
        if db.query(HostelDB).count() == 0:
            sample_hostels = [
                HostelDB(
                    id="h_1",
                    name="St. Xavier's Student Residence & PG",
                    university="Delhi University (North Campus)",
                    city="Delhi",
                    gender="Co-ed",
                    type="Premium Student Residency",
                    rent=12500.0,
                    deposit=10000.0,
                    distance=0.3,
                    rating=4.9,
                    reviews_count=28,
                    verified=True,
                    featured=True,
                    image_main="assets/images/exterior1.png",
                    image_single="assets/images/room_single.png",
                    image_shared="assets/images/room_shared.png",
                    image_mess="assets/images/mess.png",
                    address="14 Hudson Lane, Vijay Nagar, Delhi",
                    map_coords_json=json.dumps({"top": 35, "left": 48}),
                    amenities_json=json.dumps(["High-Speed Wi-Fi", "4-Time Mess", "Biometric Entry", "AC Rooms", "24/7 Power Backup", "Laundry"]),
                    curfew="10:30 PM",
                    room_sharing_json=json.dumps(["Single", "Double", "Triple"]),
                    description="Located 3 minutes from GTB Nagar Metro. Fully furnished student stay with high-speed Wi-Fi, hygienic meals, biometric safety, and study lounge.",
                    mess_menu_json=json.dumps({
                        "breakfast": "Aloo Paratha / Poha + Tea / Coffee",
                        "lunch": "Roti, Sabzi, Dal Tadka, Rice, Salad",
                        "snacks": "Samosa / Pakoda + Hot Chai",
                        "dinner": "Special Paneer Curry / Chicken, Veg Pulao, Gulab Jamun"
                    })
                ),
                HostelDB(
                    id="h_2",
                    name="Kota Scholars Residency & Mess",
                    university="Kota Coaching Hub (Talwandi)",
                    city="Kota",
                    gender="Boys",
                    type="Coaching Student Hostel",
                    rent=8500.0,
                    deposit=5000.0,
                    distance=0.2,
                    rating=4.8,
                    reviews_count=42,
                    verified=True,
                    featured=True,
                    image_main="assets/images/exterior2.png",
                    image_single="assets/images/room_single.png",
                    image_shared="assets/images/room_shared.png",
                    image_mess="assets/images/mess.png",
                    address="Sector 4, Talwandi, Kota, Rajasthan",
                    map_coords_json=json.dumps({"top": 55, "left": 62}),
                    amenities_json=json.dumps(["Silent Study Room", "4-Time Mess", "AC Rooms", "CCTV Security", "24/7 Power Backup", "Doctor on Call"]),
                    curfew="9:30 PM",
                    room_sharing_json=json.dumps(["Single", "Double"]),
                    description="Quiet environment specifically designed for JEE/NEET aspirants. Dedicated silent study rooms, nutritious balanced diet, and 24/7 security.",
                    mess_menu_json=json.dumps({
                        "breakfast": "Milk, Sprouts, Idli / Puri Bhaji",
                        "lunch": "Balanced Rajasthani Thali (Dal Bati / Chapati)",
                        "snacks": "Milk / Tea + Biscuits & Snacks",
                        "dinner": "Light Digestible Meal + Sweet Dish"
                    })
                ),
                HostelDB(
                    id="h_3",
                    name="Silicon Valley Tech Hostel & PG",
                    university="IISc & REVA University",
                    city="Bengaluru",
                    gender="Co-ed",
                    type="Co-Living Student Space",
                    rent=15000.0,
                    deposit=15000.0,
                    distance=0.5,
                    rating=4.7,
                    reviews_count=19,
                    verified=True,
                    featured=False,
                    image_main="assets/images/exterior1.png",
                    image_single="assets/images/room_single.png",
                    image_shared="assets/images/room_shared.png",
                    image_mess="assets/images/mess.png",
                    address="5th Block, Koramangala, Bengaluru, Karnataka",
                    map_coords_json=json.dumps({"top": 70, "left": 38}),
                    amenities_json=json.dumps(["Gigabit Wi-Fi", "Gaming Zone", "North & South Mess", "Housekeeping", "Gym", "App Access"]),
                    curfew="11:00 PM",
                    room_sharing_json=json.dumps(["Single", "Double"]),
                    description="Modern co-living space for engineering & tech students. Features high-speed fiber internet, rooftop chill lounge, and gaming lounge.",
                    mess_menu_json=json.dumps({
                        "breakfast": "Dosa / Idli Sambhar / Upma + Filter Coffee",
                        "lunch": "Rice, Rasam, Sambhar, Chapati, Veg Fry",
                        "snacks": "Tea / Coffee + Evening Snacks",
                        "dinner": "Roti, Veg/Non-Veg Gravy, Rice, Curd"
                    })
                )
            ]
            db.add_all(sample_hostels)

        # 3. Seed initial roommates if empty
        if db.query(RoommateDB).count() == 0:
            sample_roommates = [
                RoommateDB(
                    id="rm_1",
                    name="Aarav Sharma",
                    gender="Boys",
                    university="Delhi University",
                    major="Computer Science",
                    budget=12000.0,
                    sleep_habit="Night Owl",
                    diet="Vegetarian",
                    bio="2nd year CS student looking for a clean roommate near GTB Nagar. Likes coding and chess.",
                    avatar="AS"
                ),
                RoommateDB(
                    id="rm_2",
                    name="Ananya Roy",
                    gender="Girls",
                    university="IIT Delhi",
                    major="Architecture",
                    budget=14000.0,
                    sleep_habit="Early Bird",
                    diet="Non-Vegetarian",
                    bio="Architecture student looking for a quiet room near Hauz Khas. Clean habits, non-smoker.",
                    avatar="AR"
                )
            ]
            db.add_all(sample_roommates)

        db.commit()
        print("Database initialized cleanly with updated demo user account (Phone: 9876543210 / Pass: password123).")
    except Exception as e:
        db.rollback()
        print(f"Error initializing clean database: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()

