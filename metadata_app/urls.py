from django.urls import path
from . import views

urlpatterns = [
    path('', views.landing, name='landing'),
    path('login/', views.login_page, name='login_page'),
    path('logout/', views.logout_view, name='logout'),
    path('tool/', views.index, name='index'),
    path('api/analyze-metadata/', views.analyze_metadata, name='analyze_metadata'),
    path('api/image-to-prompt/', views.image_to_prompt, name='image_to_prompt'),
    path('api/render-eps/', views.render_eps, name='render_eps'),
    path('api/check-models/', views.check_models, name='check_models'),
]
