from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, ReviewDB, UserDB
from .auth import get_password_hash

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Delete old dummy hostels, reviews, and roommate cards
        db.query(ReviewDB).delete()
        db.query(HostelDB).delete()
        db.query(RoommateDB).delete()

        # Seed clean demo user account for instant testing
        if db.query(UserDB).filter((UserDB.phone == "9876543210") | (UserDB.email == "student@hostelkhojo.in")).count() == 0:
            demo_user = UserDB(
                id="usr_demo_1",
                full_name="Demonstration Student",
                email="student@hostelkhojo.in",
                phone="9876543210",
                password_hash=get_password_hash("password123"),
                role="student"
            )
            db.add(demo_user)

        db.commit()
        print("Database initialized cleanly with demo user account (Phone: 9876543210 / Pass: password123).")
    except Exception as e:
        db.rollback()
        print(f"Error initializing clean database: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
