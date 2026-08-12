from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, ReviewDB

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Delete all old dummy hostels, reviews, and roommate cards
        db.query(ReviewDB).delete()
        db.query(HostelDB).delete()
        db.query(RoommateDB).delete()
        db.commit()
        print("Database initialized with ZERO dummy hostels and ZERO dummy roommates.")
    except Exception as e:
        db.rollback()
        print(f"Error initializing clean database: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
