import json
from .database import engine, Base, SessionLocal
from .models import HostelDB, ReviewDB, RoommateDB, UserDB
from .auth import get_password_hash

INITIAL_HOSTELS = [
  {
    "id": "h1",
    "name": "The Stanza Living Alpha Residency",
    "university": "DU North Campus (Hudson Lane)",
    "city": "New Delhi",
    "gender": "Co-ed",
    "type": "Co-Living & Luxury PG",
    "rent": 14500,
    "deposit": 10000,
    "distance": 0.3,
    "rating": 4.9,
    "reviewsCount": 142,
    "verified": True,
    "featured": True,
    "imageMain": "assets/images/exterior1.png",
    "imageSingle": "assets/images/room_single.png",
    "imageShared": "assets/images/room_shared.png",
    "imageMess": "assets/images/mess.png",
    "address": "18 Hudson Lane, Kingsway Camp, DU North Campus, Delhi",
    "mapCoords": {"top": 32, "left": 42},
    "amenities": ["Wi-Fi", "4-Time Mess", "AC", "Gym", "Biometric Security", "Laundry", "Study Lounge", "24x7 Power Backup"],
    "curfew": "11:00 PM",
    "roomSharing": ["Single", "Double", "Triple"],
    "description": "Ultra-modern student co-living residency located 3 minutes walk from SRCC, Hindu & Hansraj colleges. Features biometric security, 300Mbps fiber Wi-Fi, chef-curated North & South Indian buffet meals, and soundproof study pods.",
    "messMenu": {
      "breakfast": "Stuffed Aloo/Paneer Parathas, Curd, Masala Chai & Filter Coffee",
      "lunch": "Rajma Chawal, Seasonal Sabzi, Butter Roti, Green Salad & Boondi Raita",
      "snacks": "Samosas / Paneer Pakoras & Garam Cutting Chai",
      "dinner": "Paneer Butter Masala / Chicken Curry, Dal Makhani, Phulka & Hot Gulab Jamun"
    },
    "reviews": [
      {"name": "Aarav Sharma", "major": "DU SRCC B.Com '26", "rating": 5, "comment": "Best student stay in North Campus! High-speed internet and delicious daily food."},
      {"name": "Priya Malhotra", "major": "DU Hindu English '27", "rating": 4.9, "comment": "Super safe with biometric access and 24/7 warden security."}
    ]
  },
  {
    "id": "h2",
    "name": "Shree Durga Girls Sanctuary PG",
    "university": "DU South Campus (Satya Niketan)",
    "city": "New Delhi",
    "gender": "Girls",
    "type": "Girls PG & Hostel",
    "rent": 11000,
    "deposit": 9000,
    "distance": 0.2,
    "rating": 4.85,
    "reviewsCount": 98,
    "verified": True,
    "featured": True,
    "imageMain": "assets/images/room_single.png",
    "imageSingle": "assets/images/room_single.png",
    "imageShared": "assets/images/room_shared.png",
    "imageMess": "assets/images/mess.png",
    "address": "142 Satya Niketan, Opposite Venkateswara College, New Delhi",
    "mapCoords": {"top": 22, "left": 68},
    "amenities": ["Wi-Fi", "4-Time Mess", "AC", "CCTV Security", "24x7 Power Backup", "RO Water", "Washing Machine"],
    "curfew": "10:00 PM",
    "roomSharing": ["Single", "Double"],
    "description": "Premium safe sanctuary for female college students. Full biometric & CCTV security, 24/7 resident lady warden, RO mineral drinking water, and hygienic North Indian home-cooked meals.",
    "messMenu": {
      "breakfast": "Masala Dosa / Poha, Coconut Chutney, Tea & Coffee",
      "lunch": "Kadhi Pakoda, Jeera Rice, Chapati, Salad",
      "snacks": "Veg Sandwich / Biscuit with Evening Chai",
      "dinner": "Shahi Paneer, Mix Veg, Phulka, Kheer"
    },
    "reviews": [
      {"name": "Ananya Iyer", "major": "DU Venky Econ '26", "rating": 5, "comment": "Walking distance to Venky College! Very safe environment and clean rooms."}
    ]
  },
  {
    "id": "h3",
    "name": "Powai Tech Scholars Boys PG",
    "university": "IIT Bombay (Powai Lake)",
    "city": "Mumbai",
    "gender": "Boys",
    "type": "Boys Student PG",
    "rent": 15500,
    "deposit": 12000,
    "distance": 0.5,
    "rating": 4.8,
    "reviewsCount": 110,
    "verified": True,
    "featured": False,
    "imageMain": "assets/images/room_shared.png",
    "imageSingle": "assets/images/room_single.png",
    "imageShared": "assets/images/room_shared.png",
    "imageMess": "assets/images/mess.png",
    "address": "Main Gate Road, Opposite Hiranandani Gardens, Powai, Mumbai",
    "mapCoords": {"top": 58, "left": 28},
    "amenities": ["Wi-Fi", "4-Time Mess", "AC", "Gym", "Power Backup", "Gaming Lounge", "Daily Housekeeping"],
    "curfew": "None (24/7 Access)",
    "roomSharing": ["Double", "Triple"],
    "description": "Vibrant boys student hostel for IIT Bombay engineering students and tech interns. Offers high-speed gaming fiber Wi-Fi, in-house gym, daily housekeeping, and 4-time meals.",
    "messMenu": {
      "breakfast": "Misal Pav / Eggs, Fresh Fruit, Filter Coffee",
      "lunch": "Maharashtrian Thali, Chapati, Dal Fry, Rice",
      "snacks": "Vada Pav & Cutting Chai",
      "dinner": "Chicken Biryani / Veg Biryani, Raita, Ice Cream"
    },
    "reviews": [
      {"name": "Rohan Kulkarni", "major": "IIT Bombay CS '26", "rating": 4.8, "comment": "Awesome Wi-Fi speed for hackathons and 24/7 access!"}
    ]
  },
  {
    "id": "h4",
    "name": "Koramangala Green Co-Living",
    "university": "Christ University",
    "city": "Bengaluru",
    "gender": "Co-ed",
    "type": "Co-Living & PG",
    "rent": 16800,
    "deposit": 15000,
    "distance": 0.4,
    "rating": 4.95,
    "reviewsCount": 135,
    "verified": True,
    "featured": True,
    "imageMain": "assets/images/exterior1.png",
    "imageSingle": "assets/images/room_single.png",
    "imageShared": "assets/images/room_shared.png",
    "imageMess": "assets/images/mess.png",
    "address": "5th Block, Koramangala, Bengaluru, Karnataka",
    "mapCoords": {"top": 38, "left": 78},
    "amenities": ["Wi-Fi", "4-Time Mess", "AC", "Gym", "Balcony", "Biometric Security", "Laundry"],
    "curfew": "11:30 PM",
    "roomSharing": ["Single", "Double"],
    "description": "Luxury private and twin-sharing co-living suites near Christ University Koramangala campus. Equipped with high-speed Wi-Fi, modern attached bathrooms, rooftop lounge, and gourmet dining.",
    "messMenu": {
      "breakfast": "Idli Vada / Eggs, Sambar, Filter Coffee",
      "lunch": "South Indian Special Thali / North Indian Thali",
      "snacks": "Banana Fritters & South Indian Filter Coffee",
      "dinner": "Butter Chicken / Paneer Makhani, Naan, Gulab Jamun"
    },
    "reviews": [
      {"name": "Meera Nair", "major": "Christ Univ BBA '27", "rating": 5, "comment": "Super serene rooftop study area and Koramangala food joints nearby!"}
    ]
  },
  {
    "id": "h5",
    "name": "Kota Coaching Scholars Hub",
    "university": "Rajiv Gandhi Nagar (Allen & Motion)",
    "city": "Kota",
    "gender": "Boys",
    "type": "Boys PG & Hostel",
    "rent": 8500,
    "deposit": 6000,
    "distance": 0.1,
    "rating": 4.75,
    "reviewsCount": 88,
    "verified": True,
    "featured": False,
    "imageMain": "assets/images/room_shared.png",
    "imageSingle": "assets/images/room_single.png",
    "imageShared": "assets/images/room_shared.png",
    "imageMess": "assets/images/mess.png",
    "address": "CP Tower Road, Rajiv Gandhi Nagar, Kota, Rajasthan",
    "mapCoords": {"top": 72, "left": 62},
    "amenities": ["Wi-Fi", "Silent Study Lounge", "4-Time Mess", "Air Cooler", "RO Water", "Power Backup"],
    "curfew": "10:30 PM",
    "roomSharing": ["Single", "Double", "Triple"],
    "description": "Focused academic residency tailored for JEE & NEET coaching aspirants in Kota. Features silent exam preparation booths, 4-time nutritious vegetarian mess meals, and 24x7 inverter backup.",
    "messMenu": {
      "breakfast": "Poha, Milk & Sprouts / Tea",
      "lunch": "Dal Baati Churma / North Indian Thali",
      "snacks": "Mathri & Garam Chai",
      "dinner": "Yellow Dal Tadka, Sev Tamatar, Chapati, Kheer"
    },
    "reviews": [
      {"name": "Ishaan Gupta", "major": "Allen JEE Aspirant", "rating": 4.7, "comment": "Very quiet environment for 12-hour study schedules!"}
    ]
  },
  {
    "id": "h6",
    "name": "Viman Nagar Orchid Girls PG",
    "university": "Symbiosis International (Viman Nagar)",
    "city": "Pune",
    "gender": "Girls",
    "type": "Girls PG & Hostel",
    "rent": 13800,
    "deposit": 11000,
    "distance": 0.3,
    "rating": 4.9,
    "reviewsCount": 92,
    "verified": True,
    "featured": True,
    "imageMain": "assets/images/room_single.png",
    "imageSingle": "assets/images/room_single.png",
    "imageShared": "assets/images/room_shared.png",
    "imageMess": "assets/images/mess.png",
    "address": "Behind Symbiosis Law Campus, Viman Nagar, Pune",
    "mapCoords": {"top": 64, "left": 40},
    "amenities": ["Wi-Fi", "4-Time Mess", "AC", "CCTV Security", "Laundry", "Housekeeping", "Study Lounge"],
    "curfew": "10:30 PM",
    "roomSharing": ["Single", "Double"],
    "description": "Boutique girls student residency near Symbiosis Law and Design institutes. Features biometric door access, daily room cleaning, high-speed Wi-Fi, and delicious multi-cuisine mess menu.",
    "messMenu": {
      "breakfast": "Upma / Uttapam, Fresh Fruit, Tea",
      "lunch": "Veg Thali, Bhakri, Matki Usal, Solkadhi",
      "snacks": "Cold Coffee & Veg Sandwich",
      "dinner": "Paneer Kadai, Dal Fry, Roti, Ice Cream"
    },
    "reviews": [
      {"name": "Sanya Verma", "major": "Symbiosis Design '26", "rating": 4.9, "comment": "Super safe and clean! Loving the Viman Nagar location."}
    ]
  }
]

INITIAL_ROOMMATES = [
  {
    "id": "r1",
    "name": "Kabir Mehta",
    "gender": "Boys",
    "university": "DU SRCC",
    "major": "B.Com Honors '26",
    "budget": 14000,
    "sleep_habit": "Night Owl",
    "diet": "Pure Veg",
    "bio": "Looking for a quiet roommate near Hudson Lane. I code Python and study finance late night.",
    "avatar": "KM"
  },
  {
    "id": "r2",
    "name": "Riya Roy",
    "gender": "Girls",
    "university": "DU Hindu College",
    "major": "English Hons '27",
    "budget": 12000,
    "sleep_habit": "Early Bird",
    "diet": "Eggitarian",
    "bio": "Love reading literature and maintaining a clean, neat room space. Morning person!",
    "avatar": "RR"
  },
  {
    "id": "r3",
    "name": "Devansh Patel",
    "gender": "Boys",
    "university": "IIT Bombay",
    "major": "Computer Science '25",
    "budget": 16000,
    "sleep_habit": "Flexible",
    "diet": "Non-Veg",
    "bio": "Competitive programmer & tech enthusiast. Need a double sharing partner in Powai.",
    "avatar": "DP"
  }
]

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Check if hostels already seeded
        if db.query(HostelDB).count() == 0:
            print("Seeding hostels and reviews...")
            for h in INITIAL_HOSTELS:
                hostel_obj = HostelDB(
                    id=h["id"],
                    name=h["name"],
                    university=h["university"],
                    city=h["city"],
                    gender=h["gender"],
                    type=h["type"],
                    rent=h["rent"],
                    deposit=h["deposit"],
                    distance=h["distance"],
                    rating=h["rating"],
                    reviews_count=h["reviewsCount"],
                    verified=h["verified"],
                    featured=h["featured"],
                    image_main=h["imageMain"],
                    image_single=h["imageSingle"],
                    image_shared=h["imageShared"],
                    image_mess=h["imageMess"],
                    address=h["address"],
                    map_coords_json=json.dumps(h["mapCoords"]),
                    amenities_json=json.dumps(h["amenities"]),
                    curfew=h["curfew"],
                    room_sharing_json=json.dumps(h["roomSharing"]),
                    description=h["description"],
                    mess_menu_json=json.dumps(h["messMenu"])
                )
                db.add(hostel_obj)

                # Seed reviews
                for rev_idx, r in enumerate(h.get("reviews", [])):
                    rev_obj = ReviewDB(
                        id=f"rev_{h['id']}_{rev_idx+1}",
                        hostel_id=h["id"],
                        user_name=r["name"],
                        major=r["major"],
                        rating=r["rating"],
                        comment=r["comment"]
                    )
                    db.add(rev_obj)

        # Check if roommates seeded
        if db.query(RoommateDB).count() == 0:
            print("Seeding roommate profiles...")
            for r in INITIAL_ROOMMATES:
                rm_obj = RoommateDB(
                    id=r["id"],
                    name=r["name"],
                    gender=r["gender"],
                    university=r["university"],
                    major=r["major"],
                    budget=r["budget"],
                    sleep_habit=r["sleep_habit"],
                    diet=r["diet"],
                    bio=r["bio"],
                    avatar=r["avatar"]
                )
                db.add(rm_obj)

        # Seed sample admin user
        if db.query(UserDB).filter(UserDB.email == "student@hostelkhojo.in").count() == 0:
            print("Seeding sample user...")
            demo_user = UserDB(
                id="user_demo_1",
                email="student@hostelkhojo.in",
                password_hash=get_password_hash("password123"),
                full_name="Demonstration Student",
                phone="+91 9876543210",
                role="student"
            )
            db.add(demo_user)

        db.commit()
        print("Database seeding completed successfully.")
    except Exception as e:
        db.rollback()
        print(f"Error seeding database: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
